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
let _flagsInitDone = false;
const LOCK_KEY = 684_221_337; // qualquer BIGINT estável

async function ensureFlagsTableOnce() {
  if (_flagsInitDone) return;

  try {
    await sql/*sql*/`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`;
  } catch {}

  try {
    const existsRes = await sql/*sql*/`SELECT to_regclass('public.clerk_user_flags') AS rel`;
    const rel = existsRes?.[0]?.rel;

    if (!rel) {
      await sql/*sql*/`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type t
                   JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'clerk_user_flags' AND n.nspname = 'public') THEN
          EXECUTE 'DROP TYPE public.clerk_user_flags';
        END IF;
      END$$;`;

      await sql/*sql*/`
        CREATE TABLE IF NOT EXISTS public.clerk_user_flags (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL DEFAULT 'user',
          locked BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await sql/*sql*/`
        CREATE INDEX IF NOT EXISTS clerk_user_flags_locked_idx
        ON public.clerk_user_flags (locked)
      `;
    }

    _flagsInitDone = true;
  } finally {
    try {
      await sql/*sql*/`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`;
    } catch {}
  }
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
function truthyFlag(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function normalizeFilter(v) {
  const raw = String(v ?? "all").trim().toLowerCase();
  if (raw === "overdue" || raw === "unpaid" || raw === "por_pagar") {
    return "overdue5";
  }
  switch (raw) {
    case "all":
    case "active":
    case "invited":
    case "locked":
    case "suspended":
    case "role:admin":
    case "role:staff":
    case "role:user":
    case "overdue5":
      return raw;
    default:
      return "all";
  }
}
function matchesFilter(u, filter) {
  if (filter === "all") return true;
  if (filter === "role:admin") return !!u?.is_admin;
  if (filter === "role:staff") return u?.role === "staff" && !u?.is_admin;
  if (filter === "role:user") return u?.role === "user" && !u?.is_admin;
  if (filter === "active") return !!u?.has_miners;
  if (filter === "invited") return !u?.has_miners;
  if (
    filter === "overdue5" ||
    filter === "overdue" ||
    filter === "unpaid" ||
    filter === "por_pagar"
  ) {
    if (u?.has_overdue_5d) return true;
    return typeof u?.oldest_unsettled_days === "number" && u.oldest_unsettled_days >= 0;
  }
  const s = u?.locked ? "locked" : String(u?.status || "");
  return s === filter;
}
function applySearchAndFilter(items, { q, filter }) {
  return items.filter((u) => {
    if (filter !== "all" && !matchesFilter(u, filter)) return false;
    if (!q) return true;
    const name = String(u?.name || "").toLowerCase();
    const email = String(u?.email || "").toLowerCase();
    const id = String(u?.id || "").toLowerCase();
    return name.includes(q) || email.includes(q) || id.includes(q);
  });
}
function sortByCreated(items, order_by) {
  const out = [...items];
  if (order_by === "-created_at") {
    out.sort((a, b) => {
      const ta = a.created_at ? +new Date(a.created_at) : 0;
      const tb = b.created_at ? +new Date(b.created_at) : 0;
      return tb - ta;
    });
  } else {
    out.sort((a, b) => {
      const ta = a.created_at ? +new Date(a.created_at) : 0;
      const tb = b.created_at ? +new Date(b.created_at) : 0;
      return ta - tb;
    });
  }
  return out;
}

async function clerkFetch(path, init = {}) {
  if (!CLERK_SECRET_KEY) {
    const e = new Error("CLERK_SECRET_KEY not set");
    // @ts-ignore
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
    // @ts-ignore
    err.retryAfter = retry;
    // @ts-ignore
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Clerk ${res.status}: ${body || "<empty>"}`);
    // @ts-ignore
    err.status = res.status;
    // @ts-ignore
    err.body = body;
    throw err;
  }
  return res.json();
}

/* ===== Mapping helpers ===== */

// Conversor robusto que aceita milissegundos (Clerk) OU segundos (outros)
function tsToIso(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function primaryEmailFromClerkUser(u) {
  const list = Array.isArray(u?.email_addresses) ? u.email_addresses : [];
  if (!list.length) return "";
  const primaryId = u?.primary_email_address_id || null;
  if (primaryId) {
    const hit = list.find(e => e?.id === primaryId);
    if (hit?.email_address) return hit.email_address;
  }
  return list[0]?.email_address || "";
}

/** Converte o user do Clerk para o payload da app, incluindo has_miners. */
function toSafeUser(u, lockedMap, minersMap) {
  const email = primaryEmailFromClerkUser(u);
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;

  const created_at   = tsToIso(u?.created_at);
  const last_active  = tsToIso(u?.last_active_at);
  const last_sign_in = tsToIso(u?.last_sign_in_at);
  const updated_at   = tsToIso(u?.updated_at);

  const clerkSuspended = !!(u?.banned || u?.locked);
  const locked = !!lockedMap.get(u.id);
  const has_miners = !!(minersMap && minersMap.get(u.id));

  const meta_role_raw = String(u?.public_metadata?.role ?? "").toLowerCase();
  const meta_role =
    meta_role_raw === "admin" ? "admin" :
    meta_role_raw === "staff" ? "staff" : "user";

  const role = meta_role === "staff" ? "staff" : "user";
  const is_admin = meta_role === "admin";

  let status = "active";
  if (locked) status = "locked";
  else if (clerkSuspended) status = "suspended";
  else if (!has_miners) status = "invited";
  else status = "active";

  return {
    id: u.id,
    email,
    name,
    role,
    meta_role,
    is_admin,
    status,
    created_at,
    last_active_at: last_active || last_sign_in || updated_at || null,
    locked,
    has_miners,
  };
}

async function attachInvoiceFlags(items) {
  const userIds = items.map((u) => String(u.id || "")).filter(Boolean);
  if (!userIds.length) return items;

  const rows = await sql/*sql*/`
    WITH base AS (
      SELECT user_id::text, MIN(created_at) AS oldest_unsettled_created_at
      FROM public.energy_invoices
      WHERE user_id = ANY(${userIds})
        AND LOWER(COALESCE(status, '')) IN (
          'pendente',
          'pending',
          'aguarda_pagamento',
          'awaiting_payment',
          'unpaid',
          'overdue'
        )
      GROUP BY user_id
    )
    SELECT
      user_id,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - oldest_unsettled_created_at)) / 86400)::int AS oldest_unsettled_days
    FROM base
  `;

  const flagsByUserId = new Map();
  for (const r of rows) {
    const days = r.oldest_unsettled_days == null ? null : Number(r.oldest_unsettled_days);
    flagsByUserId.set(String(r.user_id), {
      oldest_unsettled_days: days,
      has_overdue_5d: typeof days === "number" ? days >= 0 : false,
    });
  }

  return items.map((u) => {
    const f = flagsByUserId.get(u.id);
    if (!f) {
      return {
        ...u,
        oldest_unsettled_days: null,
        has_overdue_5d: false,
      };
    }
    return { ...u, ...f };
  });
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
    const filter = normalizeFilter(req.query.filter);
    const forceGlobalScan = truthyFlag(req.query.globalScan ?? req.query.global_scan);
    const withInvoiceFlags = truthyFlag(req.query.withInvoiceFlags);
    const needsInvoiceFlags = withInvoiceFlags || filter === "overdue5";

    const isEmailSearch = qRaw && looksLikeEmail(qRaw);
    const needsGlobalScan =
      forceGlobalScan ||
      (qRaw && !isEmailSearch) ||
      (filter !== "all" && !isEmailSearch);

    /* ========= Pesquisa/filtro global ========= */
    if (needsGlobalScan) {
      const searchCap = clamp(req.query.searchLimit ?? 2000, 100, 5000);
      const clerkPageSize = 100;

      let candidates = [];
      let clerkOffset = 0;
      let totalClerk = null;

      try {
        while (candidates.length < searchCap) {
          const sp = new URLSearchParams();
          sp.set("limit", String(clerkPageSize));
          sp.set("offset", String(clerkOffset));

          const dataPage = await clerkFetch(`/users?${sp.toString()}`);
          const usersPage = Array.isArray(dataPage?.data)
            ? dataPage.data
            : Array.isArray(dataPage)
              ? dataPage
              : [];

          if (!usersPage.length) break;

          clerkOffset += usersPage.length;
          if (totalClerk == null) {
            totalClerk = Number(dataPage?.total_count ?? 0) || null;
          }

          for (const u of usersPage) {
            if (qRaw && !isEmailSearch) {
              const email = primaryEmailFromClerkUser(u).toLowerCase();
              const name = [u.first_name, u.last_name].filter(Boolean).join(" ").toLowerCase();
              const id = String(u.id || "").toLowerCase();
              const hit =
                (name && name.includes(q)) ||
                (email && email.includes(q)) ||
                (id && id.includes(q));
              if (!hit) continue;
            }
            candidates.push(u);
            if (candidates.length >= searchCap) break;
          }

          if (totalClerk && clerkOffset >= totalClerk) break;
        }
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

      const ids = candidates.map((u) => u.id);

      const lockedRows = ids.length
        ? await sql/*sql*/`
            SELECT user_id, locked, role
            FROM public.clerk_user_flags
            WHERE user_id = ANY(${ids})
          `
        : [];
      const minersRows = ids.length
        ? await sql/*sql*/`
            SELECT DISTINCT user_id
            FROM public.miners
            WHERE user_id = ANY(${ids})
          `
        : [];

      const lockedMap = new Map(lockedRows.map((r) => [r.user_id, r.locked]));
      const minersMap = new Map(minersRows.map((r) => [r.user_id, true]));

      let items = candidates.map((u) => toSafeUser(u, lockedMap, minersMap));
      if (needsInvoiceFlags && items.length) {
        try {
          items = await attachInvoiceFlags(items);
        } catch (e) {
          console.warn(`[staff.listStaffUsers] reqId=${reqId} attachInvoiceFlags(global) failed`, e?.message || e);
        }
      }

      items = applySearchAndFilter(items, { q, filter });
      items = sortByCreated(items, order_by);
      const totalMatches = items.length;
      const paged = items.slice(offset, offset + pageSize);
      const scanCapped = candidates.length >= searchCap && (!totalClerk || clerkOffset < totalClerk);

      const hasMore = offset + paged.length < totalMatches;
      return res.json({
        items: paged,
        total: totalMatches,
        has_more: hasMore,
        pageSize,
        offset,
        reqId,
        scan_capped: scanCapped,
      });
    }

    /* ========= Listagem normal e pesquisa por email exato ========= */
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    if (isEmailSearch) {
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
    const totalBody = Number(data?.total_count);
    const total = Number.isFinite(totalBody) && totalBody >= 0 ? totalBody : null;

    const ids = users.map((u) => u.id);
    const lockedRows = ids.length
      ? await sql/*sql*/`
          SELECT user_id, locked, role
          FROM public.clerk_user_flags
          WHERE user_id = ANY(${ids})
        `
      : [];
    const minersRows = ids.length
      ? await sql/*sql*/`
          SELECT DISTINCT user_id
          FROM public.miners
          WHERE user_id = ANY(${ids})
        `
      : [];

    const lockedMap = new Map(lockedRows.map((r) => [r.user_id, r.locked]));
    const minersMap = new Map(minersRows.map((r) => [r.user_id, true]));

    let items = users.map((u) => toSafeUser(u, lockedMap, minersMap));
    if (needsInvoiceFlags && items.length) {
      try {
        items = await attachInvoiceFlags(items);
      } catch (e) {
        console.warn(`[staff.listStaffUsers] reqId=${reqId} attachInvoiceFlags(list) failed`, e?.message || e);
      }
    }

    // aqui qRaw pode ser "" ou email exato
    items = applySearchAndFilter(items, { q, filter });
    items = sortByCreated(items, order_by);

    const effectiveTotal = filter === "all" ? total : items.length;
    const hasMore =
      typeof effectiveTotal === "number"
        ? offset + items.length < effectiveTotal
        : items.length >= pageSize;
    return res.json({
      items,
      total: effectiveTotal,
      has_more: hasMore,
      pageSize,
      offset,
      reqId,
    });
  } catch (err) {
    console.error(`[staff.listStaffUsers] reqId=${reqId}`, err);
    const payload = isProd
      ? { error: "failed_list_users", reqId }
      : { error: "failed_list_users", reqId, detail: String(err?.message || err) };
    return res.status(500).json(payload);
  }
}

/* ===== GET /staff/users/count ===== */
export async function getStaffUsersCount(_req, res) {
  const reqId = genReqId();
  res.setHeader("x-request-id", reqId);

  try {
    const payload = await clerkFetch("/users/count");
    const total = Number(payload?.total_count);
    return res.json({
      total: Number.isFinite(total) && total >= 0 ? total : 0,
      reqId,
    });
  } catch (e) {
    if (e && e.message === "RATE_LIMIT") {
      res.setHeader("Retry-After", String(e.retryAfter));
      return res
        .status(429)
        .json({ error: "rate_limited", retry_after: e.retryAfter, reqId });
    }
    if (e && (e.status === 401 || e.status === 403)) {
      const payload = isProd
        ? { error: "clerk_auth_failed", reqId }
        : { error: "clerk_auth_failed", reqId, detail: e.message };
      return res.status(502).json(payload);
    }
    const payload = isProd
      ? { error: "clerk_error", reqId }
      : { error: "clerk_error", reqId, detail: e?.message || String(e) };
    return res.status(502).json(payload);
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
      INSERT INTO public.clerk_user_flags (user_id, role, locked)
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
      INSERT INTO public.clerk_user_flags (user_id, role, locked)
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

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ banned: true }),
    });

    await sql/*sql*/`
      INSERT INTO public.clerk_user_flags (user_id, role, locked)
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

    await clerkFetch(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ banned: false }),
    });

    await sql/*sql*/`
      INSERT INTO public.clerk_user_flags (user_id, role, locked)
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
