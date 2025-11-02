// controllers/staffUsersController.js
import { sql } from "../config/db.js";
import { clerkClient } from "@clerk/clerk-sdk-node";

/** Garante a tabela sombra para flags locais */
async function ensureFlagsTable() {
  await sql/*sql*/`
    CREATE TABLE IF NOT EXISTS clerk_user_flags (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',        -- 'admin' | 'user'
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
}

/* ---------- Utils ---------- */
function clamp(n, min, max) {
  const v = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function parsePaging(req) {
  const page = clamp(req.query.page ?? 1, 1, 10_000);
  const pageSize = clamp(req.query.pageSize ?? req.query.limit ?? 20, 1, 100);
  const offset = req.query.offset != null ? clamp(req.query.offset, 0, 1e9) : (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function toSafeUser(u, flagsMap) {
  const primaryEmail = (u.emailAddresses || [])[0]?.emailAddress ?? "";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || null;
  const created_at = u.createdAt ? new Date(u.createdAt).toISOString() : null;
  const last_active_at = u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null;

  // status simplificado para UI (não dependemos de campos privados do Clerk)
  // invited: nunca fez sign-in; active: default
  const invited = !u.lastActiveAt;
  const status = invited ? "invited" : "active";

  const flags = flagsMap.get(u.id) || { role: "user", locked: false };

  return {
    id: u.id,
    email: primaryEmail,
    name,
    role: flags.role === "admin" ? "admin" : "user",
    status: flags.locked ? "locked" : status, // locked tem prioridade na UI
    created_at,
    last_active_at,
    locked: !!flags.locked,
  };
}

/* ---------- GET /staff/users ---------- */
export async function listStaffUsers(req, res) {
  try {
    await ensureFlagsTable();

    const { pageSize, offset } = parsePaging(req);
    const q = norm(req.query.q || req.query.query || "");
    const order = String(req.query.order || "-created_at"); // só para compat UI

    // Clerk pagina por "limit & offset"
    const clerkPage = await clerkClient.users.getUserList({
      limit: pageSize,
      offset,
      // não há full-text global simples; tentamos pelos filtros disponíveis:
      emailAddress: q ? [q] : undefined,
      orderBy: order.startsWith("-") ? "-created_at" : "created_at",
    });

    const ids = clerkPage.data.map((u) => u.id);
    const flagsRows = ids.length
      ? await sql/*sql*/`SELECT user_id, role, locked FROM clerk_user_flags WHERE user_id = ANY(${ids})`
      : [];
    const flagsMap = new Map(flagsRows.map((r) => [r.user_id, { role: r.role, locked: r.locked }]));

    const items = clerkPage.data.map((u) => toSafeUser(u, flagsMap));

    res.json({
      items,
      total: clerkPage.totalCount ?? items.length,
      pageSize,
      offset,
    });
  } catch (err) {
    console.error("staff.listStaffUsers:", err);
    res.status(500).json({ error: "failed_list_users" });
  }
}

/* ---------- POST /staff/users/:id/lock ---------- */
export async function lockUser(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', TRUE)
      ON CONFLICT (user_id)
      DO UPDATE SET locked = EXCLUDED.locked, updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, locked: true });
  } catch (err) {
    console.error("staff.lockUser:", err);
    res.status(500).json({ error: "failed_lock" });
  }
}

/* ---------- POST /staff/users/:id/unlock ---------- */
export async function unlockUser(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id)
      DO UPDATE SET locked = EXCLUDED.locked, updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, locked: false });
  } catch (err) {
    console.error("staff.unlockUser:", err);
    res.status(500).json({ error: "failed_unlock" });
  }
}

/* ---------- POST /staff/users/:id/make-admin ---------- */
export async function makeAdmin(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'admin', FALSE)
      ON CONFLICT (user_id)
      DO UPDATE SET role = 'admin', updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, role: "admin" });
  } catch (err) {
    console.error("staff.makeAdmin:", err);
    res.status(500).json({ error: "failed_make_admin" });
  }
}

/* ---------- POST /staff/users/:id/revoke-admin ---------- */
export async function revokeAdmin(req, res) {
  try {
    await ensureFlagsTable();
    const userId = String(req.params.id || "");
    if (!userId) return res.status(400).json({ error: "missing_user_id" });

    await sql/*sql*/`
      INSERT INTO clerk_user_flags (user_id, role, locked)
      VALUES (${userId}, 'user', FALSE)
      ON CONFLICT (user_id)
      DO UPDATE SET role = 'user', updated_at = now()
    `;

    return res.json({ ok: true, user_id: userId, role: "user" });
  } catch (err) {
    console.error("staff.revokeAdmin:", err);
    res.status(500).json({ error: "failed_revoke_admin" });
  }
}
