// src/jobs/deliverPush.js
import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "../services/notificationTemplates.js";
import { sendPushToUser } from "../services/push.js";
import { userAllowsTemplate } from "../services/prefs.js";

const BATCH_SIZE = 50;

async function fetchPending() {
  return await sql/*sql*/`
    SELECT id, audience_kind, audience_ref, channel, template, payload_json, send_after_utc
    FROM notification_outbox
    WHERE status = 'pending'
      AND channel = 'push'
      AND (send_after_utc IS NULL OR send_after_utc <= NOW())
    ORDER BY id
    LIMIT ${BATCH_SIZE}
  `;
}

async function markSent(id) {
  await sql/*sql*/`UPDATE notification_outbox SET status='sent', sent_at=NOW(), error_msg=NULL WHERE id=${id}`;
}
async function markDead(id, msg) {
  await sql/*sql*/`UPDATE notification_outbox SET status='dead', error_msg=${msg ?? null} WHERE id=${id}`;
}
async function markError(id, msg) {
  await sql/*sql*/`UPDATE notification_outbox SET status='error', error_msg=${msg ?? null} WHERE id=${id}`;
}

// role → user_ids
async function getUserIdsForRole(roleName) {
  const rows = await sql/*sql*/`SELECT user_id FROM role_recipients WHERE role=${roleName}`;
  return rows.map(r => r.user_id);
}

export async function runDeliverPushOnce() {
  const rows = await fetchPending();
  if (!rows.length) return { processed: 0, sent: 0 };

  let sent = 0;
  for (const r of rows) {
    try {
      const msg = buildPushFromTemplate(r.template, r.payload_json || {});

      if (r.audience_kind === "user") {
        // ⬇️ ÚNICO gate: prefs do user
        const allow = await userAllowsTemplate(r.audience_ref, r.template, true);
        if (!allow) {
          await markDead(r.id, "prefs_blocked");
          continue;
        }

        const res = await sendPushToUser(r.audience_ref, msg);
        (res?.sent ?? 0) > 0
          ? await markSent(r.id)
          : await markDead(r.id, "no_valid_tokens");
        sent += res?.sent ?? 0;

      } else if (r.audience_kind === "role") {
        const userIds = await getUserIdsForRole(r.audience_ref);
        if (!userIds.length) {
          await markDead(r.id, "no_recipients_for_role");
          continue;
        }
        let roleSent = 0;
        for (const uid of userIds) {
          const allow = await userAllowsTemplate(uid, r.template, true);
          if (!allow) continue;
          const res = await sendPushToUser(uid, msg);
          roleSent += res?.sent ?? 0;
        }
        roleSent > 0 ? await markSent(r.id) : await markDead(r.id, "role_no_tokens");
        sent += roleSent;

      } else {
        await markDead(r.id, `unsupported_kind:${r.audience_kind}`);
      }
    } catch (e) {
      console.error("[deliverPush] erro:", e);
      await markError(r.id, String(e?.message ?? e));
    }
  }
  return { processed: rows.length, sent };
}

export function startDeliverPushLoop({ intervalMs = 15000 } = {}) {
  console.log(`⏱️ deliverPush loop every ${Math.round(intervalMs / 1000)}s`);
  const tick = async () => {
    try {
      const res = await runDeliverPushOnce();
      if (res.processed) console.log(`[deliverPush] processed=${res.processed} sent=${res.sent}`);
    } catch (e) {
      console.error("[deliverPush] fatal:", e);
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 2000);
}
