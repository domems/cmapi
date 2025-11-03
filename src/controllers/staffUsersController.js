// src/controllers/staffUsersController.js
import { sql } from "../config/db.js";

/* ===== Clerk REST (sem SDK) ===== */
const CLERK_BASE = "https://api.clerk.com/v1";
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY; // sk_*

if (!CLERK_SECRET_KEY) {
  console.warn("[staffUsersController] Missing CLERK_SECRET_KEY env var");
}

/* ===== Tabela sombra (locked + role para fallback visual) ===== */
async function ensureFlagsTable() {
  await sql/*sql*/`
    CREATE TABLE IF NOT EXISTS clerk_user_flags (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',      -- NÃO é fonte de verdade; apenas espelho
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS clerk_user_flags_locked_idx ON clerk_user_flags (locked);
  `;
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
function norm(s) { return String(s ?? "").trim().toLowerCase(); }

async function clerkFetch(path, init = {}) {
  if (!CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY not set");
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
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Clerk ${res.status}: ${body}`);
    err.status = res.status;
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
  const role = r === "staff" ? "staff" : "user"; // <— sem admin

  const locked = !!lockedMap.get(u.id);

  return {
    id: u.id,
    email,
    name,
    role,                                   // 'staff' | 'user'
    status: locked ? "locked" : baseStatus, // 'locked' tem prioridade na UI
    created_at,
    last_active_at,
    locked,
  };
}

/* ===== GET /staff/users ===== */
export async function listStaffUsers(req, res) {
  try {
    await ensureFlagsTable();

    const { pageSize, offset } = parsePaging(req);
    const q = norm(req.query.q || req.query.query || "");
    const order = String(req.query.order || "-created_at"); // compat UI

    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    params.set("order_by", order.startsWith("-") ? "-created_at" : "created_at");
    if (q) params.append("email_address", q); // Clerk não expõe full-text universal

    let data;
    try {
      data = await clerkFetch(`/users?${params.toString()}`);
    } catch (e) {
      if (e.message === "RATE_LIMIT") {
        res.setHeader("Retry-After", String(e.retryAfter));
        return res.status(429).json({ error: "rate_limited", retry_after: e.retryAfter });
      }
      throw e;
    }

    const users = Array.isArray(data?.data) ? data.data : data;
    const total = Number(data?.total_count ?? users?.length ?? 0);

    const ids = (users || []).map((u) => u.id);
    const lockedRows = ids.length
      ? await sql/*sql*/`SELECT user_id, locked FROM clerk_user_flags WHERE user_id = ANY(${ids})`
      : [];
    const lockedMap = new Map(lockedRows.map((r) => [r.user_id, r.locked]));

    const items = (users || []).map((u) => toSafeUser(u, lockedMap));
    res.json({ items, total, pageSize, offset });
  } catch (err) {
    console.error("staff.listStaffUsers:", err);
    res.status(500).json({ error: "failed_list_users" });
  }
}

/* ===== POST /staff/users/:id/make-staff ===== */
export async function makeStaff(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ public_metadata: { role: "staff" } }),
    });

    // sombra (não é fonte, mas mantém coerência visual)
    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'staff', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET role = 'staff', updated_at = now()
    `;

    res.json({ ok: true, user_id: userId, role: "staff" });
  } catch (err) {
    console.error("staff.makeStaff:", err);
    res.status(500).json({ error: "failed_make_staff" });
  }
}

/* ===== POST /staff/users/:id/revoke-staff ===== */
export async function revokeStaff(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ public_metadata: { role: "user" } }),
    });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET role = 'user', updated_at = now()
    `;

    res.json({ ok: true, user_id: userId, role: "user" });
  } catch (err) {
    console.error("staff.revokeStaff:", err);
    res.status(500).json({ error: "failed_revoke_staff" });
  }
}

/* ===== POST /staff/users/:id/lock ===== */
export async function lockUser(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', TRUE)
      ON CONFLICT (user_id) DO UPDATE SET locked = TRUE, updated_at = now()
    `;
    res.json({ ok: true, user_id: userId, locked: true });
  } catch (err) {
    console.error("staff.lockUser:", err);
    res.status(500).json({ error: "failed_lock" });
  }
}

/* ===== POST /staff/users/:id/unlock ===== */
export async function unlockUser(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id) DO UPDATE SET locked = FALSE, updated_at = now()
    `;
    res.json({ ok: true, user_id: userId, locked: false });
  } catch (err) {
    console.error("staff.unlockUser:", err);
    res.status(500).json({ error: "failed_unlock" });
  }
}
