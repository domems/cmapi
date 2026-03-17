import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "./notificationTemplates.js";
import { userAllowsTemplate } from "./prefs.js";

const STAFF_ENV_RECIPIENTS = String(process.env.STAFF_ALERT_RECIPIENTS || "")
  .split(",")
  .map((v) => String(v || "").trim())
  .filter(Boolean);

const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));
const SLOT_SAMPLE_LIMIT = 3;

function templateForTransition(fromState, toState) {
  const from = String(fromState || "").toUpperCase();
  const to = String(toState || "").toUpperCase();
  if (to === "OFFLINE") return "staff_miner_offline_p1";
  if (from === "OFFLINE" && to === "ONLINE") return "staff_miner_recovered_p2";
  if (to === "MAINTENANCE") return "staff_miner_maintenance_p2";
  return null;
}

function channelsForTemplate(template) {
  if (template.endsWith("_p1")) return ["inapp", "push"];
  return ["inapp"];
}

function severityForTemplate(template) {
  const m = String(template || "").match(/_p(\d+)$/i);
  if (m?.[1]) return `P${m[1]}`;
  return "P2";
}

async function getStaffRecipientsFromFlags() {
  try {
    const rows = asRows(await sql/*sql*/`
      SELECT user_id
      FROM public.clerk_user_flags
      WHERE locked = FALSE
        AND role IN ('staff', 'admin')
    `);
    return rows.map((r) => String(r.user_id || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getStaffRecipientsFromRoleRecipients() {
  try {
    const rows = asRows(await sql/*sql*/`
      SELECT user_id
      FROM role_recipients
      WHERE role IN ('admin', 'support')
    `);
    return rows.map((r) => String(r.user_id || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getStaffRecipientUserIds() {
  const [fromFlags, fromRoles] = await Promise.all([
    getStaffRecipientsFromFlags(),
    getStaffRecipientsFromRoleRecipients(),
  ]);
  return Array.from(new Set([...fromFlags, ...fromRoles, ...STAFF_ENV_RECIPIENTS]));
}

function snapshotFilterForTemplate(template, toStateUpper) {
  if (template === "staff_miner_offline_p1") {
    return sql`AND e.to_state = 'OFFLINE'`;
  }
  if (template === "staff_miner_recovered_p2") {
    return sql`AND e.from_state = 'OFFLINE' AND e.to_state = 'ONLINE'`;
  }
  if (template === "staff_miner_maintenance_p2") {
    return sql`AND e.to_state = 'MAINTENANCE'`;
  }
  return sql`AND e.to_state = ${toStateUpper}`;
}

async function getTemplateSlotSnapshot(template, slotIso, toStateUpper) {
  if (!slotIso) return { batchCount: 0, workers: [] };

  const filter = snapshotFilterForTemplate(template, toStateUpper);

  const countRows = asRows(await sql/*sql*/`
    SELECT COUNT(DISTINCT e.miner_id)::int AS count
    FROM miner_state_events e
    WHERE e.slot_iso = ${slotIso}
      ${filter}
  `);

  const workerRows = asRows(await sql/*sql*/`
    SELECT DISTINCT ON (e.miner_id)
      e.miner_id,
      COALESCE(NULLIF(m.worker_name, ''), 'Miner #' || e.miner_id::text) AS worker_name
    FROM miner_state_events e
    LEFT JOIN miners m ON m.id = e.miner_id
    WHERE e.slot_iso = ${slotIso}
      ${filter}
    ORDER BY e.miner_id, e.id DESC
    LIMIT ${SLOT_SAMPLE_LIMIT}
  `);

  const workers = workerRows
    .map((r) => String(r.worker_name || "").trim())
    .filter(Boolean);

  return {
    batchCount: Number(countRows?.[0]?.count || 0),
    workers,
  };
}

export async function enqueueStaffStateAlert({
  minerId,
  workerName,
  fromState,
  toState,
  slotIso,
  occurredAtUtc,
}) {
  const template = templateForTransition(fromState, toState);
  if (!template) return { recipients: 0, enqueued: 0 };

  const recipients = await getStaffRecipientUserIds();
  if (!recipients.length) return { recipients: 0, enqueued: 0 };

  const channels = channelsForTemplate(template);
  const severity = severityForTemplate(template);
  const nowIso = occurredAtUtc || new Date().toISOString();

  const payload = {
    minerId,
    worker: workerName || null,
    from: String(fromState || "").toUpperCase(),
    to: String(toState || "").toUpperCase(),
    slot: slotIso || null,
    atUtc: nowIso,
    severity,
  };

  let enqueued = 0;
  const toStateUpper = String(toState || "").toUpperCase();
  const slotSnapshot = await getTemplateSlotSnapshot(template, slotIso, toStateUpper);

  for (const userId of recipients) {
    const templateAllowed = await userAllowsTemplate(userId, template, true);
    if (!templateAllowed) continue;

    const effectivePayload = {
      ...payload,
      batchCount: Math.max(1, Number(slotSnapshot?.batchCount || 0)),
      workers: Array.isArray(slotSnapshot?.workers) ? slotSnapshot.workers : [],
    };

    // compat com payload legado de OFFLINE batch (se já existir no front)
    if (template === "staff_miner_offline_p1") {
      effectivePayload.offlineCount = effectivePayload.batchCount;
    }

    const effectiveInappPayload = buildPushFromTemplate(template, effectivePayload);

    const baseDedupe = `staff:${template}:u:${userId}:slot:${slotIso}:batch`;

    if (channels.includes("inapp")) {
      const rInapp = asRows(await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json, status, send_after_utc)
        VALUES
          (${`${baseDedupe}:inapp`}, 'user', ${userId}, 'inapp', ${template}, ${JSON.stringify(effectiveInappPayload)}::jsonb, 'sent', NOW())
        ON CONFLICT (dedupe_key) DO UPDATE
          SET payload_json = EXCLUDED.payload_json
        RETURNING id
      `);
      enqueued += rInapp.length;
    }

    if (channels.includes("push")) {
      const rPush = asRows(await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
        VALUES
          (${`${baseDedupe}:push`}, 'user', ${userId}, 'push', ${template}, ${JSON.stringify(effectivePayload)}::jsonb)
        ON CONFLICT (dedupe_key) DO UPDATE
          SET payload_json = EXCLUDED.payload_json
        RETURNING id
      `);
      enqueued += rPush.length;
    }
  }

  return { recipients: recipients.length, enqueued };
}
