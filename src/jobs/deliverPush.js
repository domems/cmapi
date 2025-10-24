// src/jobs/deliverPush.js
import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "../services/notificationTemplates.js";
import { sendPushToUser } from "../services/push.js";
import { userAllowsTemplate } from "../services/prefs.js";

const BATCH_SIZE = 50;

/* -------------------------- DB helpers -------------------------- */

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
  await sql/*sql*/`
    UPDATE notification_outbox
    SET status='sent', sent_at_utc=NOW(), attempts=attempts+1, error_msg=NULL
    WHERE id=${id}
  `;
}

async function markDead(id, msg) {
  await sql/*sql*/`
    UPDATE notification_outbox
    SET status='dead', attempts=attempts+1, error_msg=${msg ?? null}
    WHERE id=${id}
  `;
  await sql/*sql*/`
    INSERT INTO notification_receipts (outbox_id, success, error)
    VALUES (${id}, FALSE, ${msg ?? null})
  `;
}

async function markError(id, msg) {
  await sql/*sql*/`
    UPDATE notification_outbox
    SET status='error', attempts=attempts+1, error_msg=${msg ?? null}
    WHERE id=${id}
  `;
  await sql/*sql*/`
    INSERT INTO notification_receipts (outbox_id, success, error)
    VALUES (${id}, FALSE, ${msg ?? null})
  `;
}

async function insertSuccessReceipts(outboxId, receipts /* string[] | undefined */) {
  if (Array.isArray(receipts) && receipts.length) {
    const values = receipts.map((r) => `(${outboxId}, TRUE, '${String(r).replace(/'/g, "''")}')`).join(",");
    await sql.unsafe(`INSERT INTO notification_receipts (outbox_id, success, channel_msg_id) VALUES ${values}`);
  } else {
    await sql/*sql*/`
      INSERT INTO notification_receipts (outbox_id, success)
      VALUES (${outboxId}, TRUE)
    `;
  }
}

/* ---- role → users ---- */
async function getUserIdsForRole(roleName) {
  const rows = await sql/*sql*/`
    SELECT user_id
    FROM role_recipients
    WHERE role=${roleName}
  `;
  return rows.map((r) => r.user_id);
}

/* ----------------------- Core dispatcher ------------------------ */

export async function runDeliverPushOnce() {
  const rows = await fetchPending();
  if (!rows.length) return { processed: 0, sent: 0 };

  let sent = 0;

  for (const r of rows) {
    try {
      const payload = r.payload_json || {};
      const msg = buildPushFromTemplate(r.template, payload); // { title, body, data }

      if (r.audience_kind === "user") {
        // Prefs no Clerk
        const allow = await userAllowsTemplate(r.audience_ref, r.template, true);
        if (!allow) {
          await markDead(r.id, "prefs_blocked");
          continue;
        }

        const res = await sendPushToUser(r.audience_ref, msg);
        const count = Number(res?.sent || 0);

        if (count > 0) {
          await insertSuccessReceipts(r.id, res.receipts);
          await markSent(r.id);
          sent += count;
        } else {
          await markDead(r.id, "no_valid_tokens");
        }

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
          const count = Number(res?.sent || 0);
          roleSent += count;

          if (count > 0) {
            await insertSuccessReceipts(r.id, res.receipts);
          }
        }

        if (roleSent > 0) {
          await markSent(r.id);
          sent += roleSent;
        } else {
          await markDead(r.id, "role_no_tokens_or_blocked");
        }

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

/* -------------------------- Loop runner ------------------------- */

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
