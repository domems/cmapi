import { sql } from "../config/db.js";

const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

function clamp(v, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function getStaffUserId(req) {
  return String(req.auth?.userId || "").trim();
}

function parseBeforeId(input) {
  const n = Number.parseInt(String(input ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function listStaffNotifications(req, res) {
  const userId = getStaffUserId(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const limit = clamp(req.query.limit ?? 60, 1, 100);
    const beforeId = parseBeforeId(req.query.before_id);

    const rows = asRows(await sql/*sql*/`
      SELECT
        o.id,
        o.template,
        o.payload_json,
        o.status,
        o.send_after_utc,
        COALESCE(r.max_delivered_at, o.send_after_utc) AS delivered_at_utc,
        (ur.outbox_id IS NOT NULL) AS is_read,
        ur.read_at_utc AS acknowledged_at_utc
      FROM notification_outbox o
      LEFT JOIN LATERAL (
        SELECT rr.delivered_at_utc AS max_delivered_at
        FROM notification_receipts rr
        WHERE rr.outbox_id = o.id
        ORDER BY rr.delivered_at_utc DESC
        LIMIT 1
      ) r ON TRUE
      LEFT JOIN notification_user_reads ur
        ON ur.outbox_id = o.id AND ur.user_id = ${userId}
      WHERE o.audience_kind = 'user'
        AND o.audience_ref = ${userId}
        AND o.channel = 'inapp'
        AND o.template LIKE 'staff_%'
        AND o.status IN ('sent', 'pending')
        ${beforeId ? sql`AND o.id < ${beforeId}` : sql``}
      ORDER BY o.id DESC
      LIMIT ${limit}
    `);

    const next_before_id = rows.length === limit ? rows[rows.length - 1].id : null;
    return res.json({ items: rows, next_before_id });
  } catch (err) {
    req.log?.error({ err }, "staff.notifications.list failed");
    return res.status(500).json({ items: [], next_before_id: null, error: "internal_error" });
  }
}

export async function unreadStaffNotificationsCount(req, res) {
  const userId = getStaffUserId(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const rows = asRows(await sql/*sql*/`
      SELECT COUNT(*)::int AS count
      FROM notification_outbox o
      WHERE o.audience_kind = 'user'
        AND o.audience_ref = ${userId}
        AND o.channel = 'inapp'
        AND o.template LIKE 'staff_%'
        AND o.status IN ('sent', 'pending')
        AND NOT EXISTS (
          SELECT 1
          FROM notification_user_reads ur
          WHERE ur.outbox_id = o.id
            AND ur.user_id = ${userId}
        )
    `);
    return res.json({ count: Number(rows?.[0]?.count || 0) });
  } catch (err) {
    req.log?.error({ err }, "staff.notifications.unreadCount failed");
    return res.status(500).json({ count: 0, error: "internal_error" });
  }
}

export async function ackStaffNotification(req, res) {
  const userId = getStaffUserId(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const id = Number.parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const rows = asRows(await sql/*sql*/`
      SELECT id
      FROM notification_outbox
      WHERE id = ${id}
        AND audience_kind = 'user'
        AND audience_ref = ${userId}
        AND channel = 'inapp'
        AND template LIKE 'staff_%'
      LIMIT 1
    `);
    if (!rows.length) return res.status(404).json({ error: "not_found" });

    await sql/*sql*/`
      INSERT INTO notification_user_reads (outbox_id, user_id)
      VALUES (${id}, ${userId})
      ON CONFLICT (outbox_id, user_id) DO NOTHING
    `;

    return res.status(204).end();
  } catch (err) {
    req.log?.error({ err }, "staff.notifications.ackOne failed");
    return res.status(500).json({ error: "internal_error" });
  }
}

export async function ackAllStaffNotifications(req, res) {
  const userId = getStaffUserId(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  try {
    const beforeId = parseBeforeId(req.body?.before_id);

    await sql/*sql*/`
      INSERT INTO notification_user_reads (outbox_id, user_id)
      SELECT o.id, ${userId}
      FROM notification_outbox o
      WHERE o.audience_kind = 'user'
        AND o.audience_ref = ${userId}
        AND o.channel = 'inapp'
        AND o.template LIKE 'staff_%'
        AND o.status IN ('sent', 'pending')
        ${beforeId ? sql`AND o.id < ${beforeId}` : sql``}
      ON CONFLICT (outbox_id, user_id) DO NOTHING
    `;

    return res.status(204).end();
  } catch (err) {
    req.log?.error({ err }, "staff.notifications.ackAll failed");
    return res.status(500).json({ error: "internal_error" });
  }
}
