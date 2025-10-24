// src/jobs/deliverPush.js
import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "../services/notificationTemplates.js";
import { sendPushToUser } from "../services/push.js";

// Processa até N por iteração
const BATCH_SIZE = 50;

/** Lê pendentes prontos a enviar */
async function fetchPending() {
  return await sql/*sql*/`
    SELECT id, audience_kind, audience_ref, channel, template, payload_json, send_after_utc
    FROM notification_outbox
    WHERE status = 'pending'
      AND channel = 'push'
      AND (send_after_utc IS NULL OR send_after_utc <= NOW())
    ORDER BY id ASC
    LIMIT ${BATCH_SIZE};
  `;
}

/** Helpers para marcar status */
async function markSent(id) {
  await sql/*sql*/`UPDATE notification_outbox SET status='sent', sent_at=NOW(), error_msg=NULL WHERE id=${id}`;
}
async function markDead(id, msg) {
  await sql/*sql*/`UPDATE notification_outbox SET status='dead', error_msg=${msg ?? null} WHERE id=${id}`;
}
async function markError(id, msg) {
  await sql/*sql*/`UPDATE notification_outbox SET status='error', error_msg=${msg ?? null} WHERE id=${id}`;
}

/** Respeita user_notification_prefs */
async function userAllows(template, userId) {
  const key =
    template === "miner_offline"   ? "miner_status_offline" :
    template === "miner_recovered" ? "miner_status_online"  :
    template;

  const rows = await sql/*sql*/`
    SELECT enabled FROM user_notification_prefs
    WHERE user_id=${userId} AND key=${key}
    LIMIT 1;
  `;
  if (!rows.length) return true; // default ON
  return !!rows[0].enabled;
}

/** Mapeia role → lista de user_ids */
async function getRoleUsers(roleName) {
  const rows = await sql/*sql*/`SELECT user_id FROM role_recipients WHERE role=${roleName}`;
  return rows.map(r => r.user_id);
}

/** Uma iteração */
export async function runDeliverPushOnce() {
  const rows = await fetchPending();
  if (!rows.length) return { processed: 0, sent: 0 };

  let sent = 0;
  for (const r of rows) {
    try {
      const msg = buildPushFromTemplate(r.template, r.payload_json || {});
      if (r.audience_kind === "user") {
        const allow = await userAllows(r.template, r.audience_ref);
        if (!allow) {
          await markDead(r.id, "prefs_blocked");
          continue;
        }

        const result = await sendPushToUser(r.audience_ref, msg);
        (result?.sent ?? 0) > 0
          ? await markSent(r.id)
          : await markDead(r.id, "no_valid_tokens");
        sent += result?.sent ?? 0;
      } else if (r.audience_kind === "role") {
        const userIds = await getRoleUsers(r.audience_ref);
        if (!userIds.length) {
          await markDead(r.id, "no_recipients_for_role");
          continue;
        }

        let roleSent = 0;
        for (const uid of userIds) {
          if (!(await userAllows(r.template, uid))) continue;
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

/** Loop contínuo (a cada 15s) */
export function startDeliverPushLoop({ intervalMs = 15000 } = {}) {
  console.log(`⏱️ deliverPush loop every ${Math.round(intervalMs / 1000)}s`);
  const tick = async () => {
    try {
      const res = await runDeliverPushOnce();
      if (res.processed) {
        console.log(`[deliverPush] processed=${res.processed} sent=${res.sent}`);
      }
    } catch (e) {
      console.error("[deliverPush] fatal:", e);
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 2000);
}
