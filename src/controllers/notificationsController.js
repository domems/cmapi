// routes/meNotifications.js (ou o teu ficheiro atual)
import { sql } from "../config/db.js";

const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function getUserIdLoose(req) {
  return (
    req.auth?.userId ||
    req.user?.id ||
    req.headers["x-user-id"] ||
    req.headers["x-user-email"] || // se algum dia deres por email
    null
  );
}

function clamp(v, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * GET /me/notifications?limit=20&before_id=12345
 * -> { items: [...], next_before_id: number|null }
 */
export async function listMyNotifications(req, res) {
  const userId = getUserIdLoose(req);

  // 🔴 se não temos utilizador, NÃO rebenta → devolve vazio
  if (!userId) {
    return res.json({ items: [], next_before_id: null });
  }

  try {
    const limit = clamp(req.query.limit ?? 20, 1, 100);
    const beforeIdRaw = req.query.before_id ? Number(req.query.before_id) : null;
    const beforeId =
      beforeIdRaw && Number.isFinite(beforeIdRaw) ? beforeIdRaw : null;

    const rows = asRows(await sql/*sql*/`
      WITH base AS (
        SELECT
          o.id,
          o.template,
          o.payload_json,
          o.status,
          o.send_after_utc,
          COALESCE(
            (
              SELECT MAX(r.delivered_at_utc)
              FROM notification_receipts r
              WHERE r.outbox_id = o.id
            ),
            o.send_after_utc
          ) AS delivered_at_utc,
          EXISTS (
            SELECT 1
            FROM notification_user_reads ur
            WHERE ur.outbox_id = o.id
              AND ur.user_id = ${userId}
          ) AS is_read
        FROM notification_outbox o
        WHERE
          o.audience_kind = 'user'
          AND o.audience_ref = ${userId}
          AND o.channel = 'inapp'
          AND o.status IN ('sent', 'pending')
          ${beforeId ? sql`AND o.id < ${beforeId}` : sql``}
        ORDER BY o.id DESC
        LIMIT ${limit}
      )
      SELECT * FROM base;
    `);

    const next_before_id =
      rows.length === limit ? rows[rows.length - 1].id : null;

    return res.json({ items: rows, next_before_id });
  } catch (e) {
    console.error("listMyNotifications error:", e);
    // 👇 mesmo a dar erro, devolve shape certo
    return res.status(500).json({
      items: [],
      next_before_id: null,
      error: "internal_error",
    });
  }
}

/** GET /me/notifications/unread_count -> { count: number } */
export async function unreadCount(req, res) {
  const userId = getUserIdLoose(req);
  if (!userId) {
    // se não há user -> 0, ponto.
    return res.json({ count: 0 });
  }

  try {
    const rows = asRows(await sql/*sql*/`
      SELECT COUNT(*)::int AS count
      FROM notification_outbox o
      WHERE o.audience_kind='user'
        AND o.audience_ref=${userId}
        AND o.channel='inapp'
        AND o.status IN ('sent','pending')
        AND NOT EXISTS (
          SELECT 1 FROM notification_user_reads ur
          WHERE ur.outbox_id = o.id AND ur.user_id = ${userId}
        )
    `);
    return res.json({ count: rows[0]?.count ?? 0 });
  } catch (e) {
    console.error("unreadCount error:", e);
    return res.status(500).json({ count: 0, error: "internal_error" });
  }
}

/** POST /me/notifications/:id/read  (204) */
export async function markMyNotificationRead(req, res) {
  const userId = getUserIdLoose(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const row = asRows(await sql/*sql*/`
      SELECT id
      FROM notification_outbox
      WHERE id=${id}
        AND audience_kind='user'
        AND audience_ref=${userId}
        AND channel='inapp'
      LIMIT 1;
    `)[0];

    if (!row) return res.status(404).json({ error: "not_found" });

    await sql/*sql*/`
      INSERT INTO notification_user_reads (outbox_id, user_id)
      VALUES (${id}, ${userId})
      ON CONFLICT (outbox_id, user_id) DO NOTHING;
    `;

    return res.status(204).end();
  } catch (e) {
    console.error("markMyNotificationRead error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}

/**
 * POST /me/notifications/read_all  { before_id?: number }
 */
export async function markAllMyNotificationsRead(req, res) {
  const userId = getUserIdLoose(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const beforeIdRaw = req.body?.before_id ? Number(req.body.before_id) : null;
    const beforeId =
      beforeIdRaw && Number.isFinite(beforeIdRaw) ? beforeIdRaw : null;

    await sql/*sql*/`
      INSERT INTO notification_user_reads (outbox_id, user_id)
      SELECT o.id, ${userId}
      FROM notification_outbox o
      WHERE o.audience_kind='user'
        AND o.audience_ref=${userId}
        AND o.channel='inapp'
        AND o.status IN ('sent','pending')
        ${beforeId ? sql`AND o.id < ${beforeId}` : sql``}
      ON CONFLICT (outbox_id, user_id) DO NOTHING;
    `;

    return res.status(204).end();
  } catch (e) {
    console.error("markAllMyNotificationsRead error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
