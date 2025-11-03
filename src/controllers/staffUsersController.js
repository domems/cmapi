// src/controllers/staffUsersController.js
import { sql } from "../config/db.js";

/* ===== Clerk REST (sem SDK) ===== */
const CLERK_BASE = "https://api.clerk.com/v1";
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY; // sk_*
const isProd = process.env.NODE_ENV === "production";

if (!CLERK_SECRET_KEY) {
  console.warn("[staffUsersController] Missing CLERK_SECRET_KEY env var");
}

/* ===== Tabela sombra (locked + role para fallback visual) ===== */
// Neon serverless NÃO permite múltiplas statements no mesmo sql``.
// Separa e corre só uma vez.
let _flagsInitDone = false;
async function ensureFlagsTableOnce() {
  if (_flagsInitDone) return;
  await sql/*sql*/`
    CREATE TABLE IF NOT EXISTS clerk_user_flags (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql/*sql*/`
    CREATE INDEX IF NOT EXISTS clerk_user_flags_locked_idx
    ON clerk_user_flags (locked)
  `;
  _flagsInitDone = true;
}

/* ===== Utils ===== */
function clamp(n, min, max) {
  const v = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
function parsePaging(req) {
  const pageSize = clamp(req.query.pageSize ?? req.query.limit ?? 20, 1, 100);
  const offset =
    req.query.offset != null
      ? clamp(req.query.offset, 0, 1e9)
      : (clamp(req.query.page ?? 1, 1, 10_000) - 1) * pageSize;
  return { pageSize, offset };
}
function norm(s) { return String(s ?? "").trim(); }
function looksLikeEmail(s) { return /\S+@\S+\.\S+/.test(s); }
function genReqId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function clerkFetch(path, init = {}) {
  if (!CLERK_SECRET_KEY) {
    const e = new Error("CLERK_SECRET_KEY not set");
    e.code = "CONFIG";
    throw e;
  }
  const res = await fetch(`${CLERK_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (res.status === 429) {
    const retry = Math.min(Math.max(Number(res.headers.get("Retry-After")) || 60, 5), 300);
    const err = new Error("RATE_LIMIT");
    err.retryAfter = retry;
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Clerk ${res.status}: ${body || "<empty>"}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

/* ===== Mapping ===== */
function toSafeUser(u, lockedMap) {
  const email =
    (u.email_addresses && u.email_addresses[0]?.email_address) ||
    u.primary_email_address_id ||
    "";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
  const created_at = u.created_at ? new Date(u.created_at * 1000).toISOString() : null;
  const last_active_at = u.last_active_at ? new Date(u.last_active_at * 1000).toISOString() : null;

  const invited = !u.last_active_at;
  const baseStatus = invited ? "invited" : "active";

  const r = String(u.public_metadata?.role || "user").toLowerCase();
  const role = r === "staff" ? "staff" : "user";

  const locked = !!lockedMap.get(u.id);

  return {
    id: u.id,
    email,
    name,
    role,
    status: locked ? "locked" : baseStatus,
    created_at,
    last_active_at,
    locked,
  };
}

/* ===== GET /staff/users ===== */
export async function listStaffUsers(req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    await ensureFlagsTableOnce();

    const { pageSize, offset } = parsePaging(req);
    const qRaw = norm(req.query.q || req.query.query || "");
    const q = qRaw.toLowerCase();
    const orderParam = String(req.query.order || "-created_at");
    const order_by = orderParam.startsWith("-") ? "-created_at" : "created_at";

    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    params.set("order_by", order_by);
    if (qRaw && looksLikeEmail(qRaw)) {
      params.append("email_address", qRaw);
    }

    let data;
    try {
      data = await clerkFetch(`/users?${params.toString()}`);
    } catch (e) {
      if (e && e.message === "RATE_LIMIT") {
        res.setHeader("Retry-After", String(e.retryAfter));
        return res.status(429).json({ error: "rate_limited", retry_after: e.retryAfter, reqId });
      }
      if (e && (e.status === 401 || e.status === 403)) {
        const payload = isProd
          ? { error: "clerk_auth_failed", reqId }
          : { error: "clerk_auth_failed", reqId, detail: e.message };
        return res.status(502).json(payload);
      }
      const payload = isProd
        ? { error: "clerk_error", reqId }
        : { error: "clerk_error", reqId, detail: e.message };
      return res.status(502).json(payload);
    }

    const users = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const total = Number(data?.total_count ?? (Array.isArray(users) ? users.length : 0));

    const ids = users.map((u) => u.id);
    const lockedRows = ids.length
      ? await sql/*sql*/`SELECT user_id, locked, role FROM clerk_user_flags WHERE user_id = ANY(${ids})`
      : [];
    const lockedMap = new Map(lockedRows.map((r) => [r.user_id, r.locked]));

    let items = users.map((u) => toSafeUser(u, lockedMap));

    if (qRaw && !looksLikeEmail(qRaw)) {
      const ql = q;
      items = items.filter(
        (it) =>
          (it.name || "").toLowerCase().includes(ql) ||
          (it.email || "").toLowerCase().includes(ql) ||
          (it.id || "").toLowerCase().includes(ql)
      );
    }

    if (order_by === "-created_at") {
      items.sort((a, b) => {
        const ta = a.created_at ? +new Date(a.created_at) : 0;
        const tb = b.created_at ? +new Date(b.created_at) : 0;
        return tb - ta;
      });
    } else {
      items.sort((a, b) => {
        const ta = a.created_at ? +new Date(a.created_at) : 0;
        const tb = b.created_at ? +new Date(b.created_at) : 0;
        return ta - tb;
      });
    }

    return res.json({ items, total, pageSize, offset, reqId });
  } catch (err) {
    console.error(`[staff.listStaffUsers] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_list_users", reqId }
      : { error: "failed_list_users", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}

/* ===== POST /staff/users/:id/make-staff ===== */
export async function makeStaff(req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    await ensureFlagsTableOnce();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id", reqId });

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ public_metadata: { role: "staff" } }),
    });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'staff', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET role = 'staff', updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, role: "staff", reqId });
  } catch (err) {
    console.error(`[staff.makeStaff] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_make_staff", reqId }
      : { error: "failed_make_staff", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}

/* ===== POST /staff/users/:id/revoke-staff ===== */
export async function revokeStaff(req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    await ensureFlagsTableOnce();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id", reqId });

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ public_metadata: { role: "user" } }),
    });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET role = 'user', updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, role: "user", reqId });
  } catch (err) {
    console.error(`[staff.revokeStaff] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_revoke_staff", reqId }
      : { error: "failed_revoke_staff", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}

/* ===== POST /staff/users/:id/lock ===== */
export async function lockUser(req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    await ensureFlagsTableOnce();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id", reqId });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', TRUE)
      ON CONFLICT (user_id) DO UPDATE SET locked = TRUE, updated_at = now()
    `;
    return res.json({ ok: true, user_id: userId, locked: true, reqId });
  } catch (err) {
    console.error(`[staff.lockUser] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_lock", reqId }
      : { error: "failed_lock", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}

/* ===== POST /staff/users/:id/unlock ===== */
export async function unlockUser(req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    await ensureFlagsTableOnce();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id", reqId });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET locked = FALSE, updated_at = now()
    `;
    return res.json({ ok: true, user_id: userId, locked: false, reqId });
  } catch (err) {
    console.error(`[staff.unlockUser] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_unlock", reqId }
      : { error: "failed_unlock", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}
