import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "./notificationTemplates.js";

const STAFF_ENV_RECIPIENTS = String(process.env.STAFF_ALERT_RECIPIENTS || "")
  .split(",")
  .map((v) => String(v || "").trim())
  .filter(Boolean);

const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

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
  const severity = template.endsWith("_p1") ? "P1" : "P2";
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

  const inappPayload = buildPushFromTemplate(template, payload);
  let enqueued = 0;

  for (const userId of recipients) {
    const baseDedupe = `staff:${template}:u:${userId}:miner:${minerId}:slot:${slotIso}`;

    if (channels.includes("inapp")) {
      const rInapp = asRows(await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json, status, send_after_utc)
        VALUES
          (${`${baseDedupe}:inapp`}, 'user', ${userId}, 'inapp', ${template}, ${JSON.stringify(inappPayload)}::jsonb, 'sent', NOW())
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      `);
      enqueued += rInapp.length;
    }

    if (channels.includes("push")) {
      const rPush = asRows(await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
        VALUES
          (${`${baseDedupe}:push`}, 'user', ${userId}, 'push', ${template}, ${JSON.stringify(payload)}::jsonb)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      `);
      enqueued += rPush.length;
    }
  }

  return { recipients: recipients.length, enqueued };
}
