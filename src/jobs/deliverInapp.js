// src/jobs/deliverInapp.js
import { sql } from "../config/db.js";

/** ---- Helpers de prefs ---- */
async function channelInappEnabled(userId) {
  // Se existir `channels` em user_notification_prefs, usa; senão default = ON
  const rows = await sql/*sql*/`
    SELECT channels
    FROM user_notification_prefs
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const channels = Array.isArray(rows?.[0]?.channels) ? rows[0].channels : null;
  if (!channels) return true; // default ON
  return channels.includes("inapp");
}

async function templateAllowed(userId, template) {
  // Suporta chaves específicas (ex.: miner_status_offline, invoice_closed)
  const key =
    template === "miner_offline"   ? "miner_status_offline" :
    template === "miner_recovered" ? "miner_status_online"  :
    template;

  const rows = await sql/*sql*/`
    SELECT enabled
    FROM user_notification_prefs
    WHERE user_id = ${userId} AND key = ${key}
    LIMIT 1
  `;
  if (!rows.length) return true; // default ON
  return !!rows[0].enabled;
}

/** ---- Fetch pendentes ---- */
const BATCH_SIZE = 100;

async function fetchPendingInapp() {
  return await sql/*sql*/`
    SELECT id, audience_kind, audience_ref, template, payload_json
    FROM notification_outbox
    WHERE status = 'pending'
      AND channel = 'inapp'
      AND (send_after_utc IS NULL OR send_after_utc <= NOW())
    ORDER BY id
    LIMIT ${BATCH_SIZE}
  `;
}

/** ---- Marcar estados ---- */
async function markSent(ids) {
  if (!ids.length) return;
  await sql/*sql*/`
    UPDATE notification_outbox
    SET status = 'sent', sent_at = NOW(), error_msg = NULL
    WHERE id = ANY(${ids})
  `;
}

async function markDead(ids, reason) {
  if (!ids.length) return;
  await sql/*sql*/`
    UPDATE notification_outbox
    SET status = 'dead', error_msg = ${reason ?? null}
    WHERE id = ANY(${ids})
  `;
}

async function insertReceipts(rows, success, errorMsg = null) {
  if (!rows.length) return;
  const values = rows.map((r) => `(${r.id}, ${success ? "TRUE" : "FALSE"}, ${errorMsg ? `'${errorMsg.replace(/'/g, "''")}'` : "NULL"})`).join(",");
  await sql.unsafe(`
    INSERT INTO notification_receipts (outbox_id, success, error)
    VALUES ${values}
  `);
}

/** ---- Uma iteração ---- */
export async function runDeliverInappOnce() {
  const rows = await fetchPendingInapp();
  if (!rows.length) return { picked: 0, delivered: 0 };

  // Agrupar por audiência
  const byAudience = new Map();
  for (const n of rows) {
    const key = `${n.audience_kind}:${n.audience_ref}`;
    if (!byAudience.has(key)) byAudience.set(key, []);
    byAudience.get(key).push(n);
  }

  let delivered = 0;
  const toSent = [];
  const toDeadPrefs = [];
  const toDeadUnsupported = [];

  for (const [audKey, items] of byAudience.entries()) {
    const [kind, ref] = audKey.split(":");

    if (kind === "user") {
      const [chanOn, templatesOk] = await Promise.all([
        channelInappEnabled(ref),
        Promise.all(items.map((it) => templateAllowed(ref, it.template))),
      ]);

      // Se canal está OFF, mata tudo deste user
      if (!chanOn) {
        toDeadPrefs.push(...items);
        continue;
      }

      // Envia (torna “available” in-app) apenas os templates permitidos
      const allowed = items.filter((it, i) => templatesOk[i]);
      const blocked = items.filter((it, i) => !templatesOk[i]);

      if (allowed.length) {
        toSent.push(...allowed);
        delivered += allowed.length;
      }
      if (blocked.length) toDeadPrefs.push(...blocked);

    } else if (kind === "role") {
      // In-app para roles: ou tens feed partilhado por role (não tens),
      // ou marcas como dead para não ficar pendurado.
      toDeadUnsupported.push(...items);
    } else {
      toDeadUnsupported.push(...items);
    }
  }

  // Persistir alterações
  await markSent(toSent.map((r) => r.id));
  await insertReceipts(toSent, true);

  await markDead(toDeadPrefs.map((r) => r.id), "prefs_blocked_inapp");
  if (toDeadPrefs.length) await insertReceipts(toDeadPrefs, false, "prefs_blocked_inapp");

  await markDead(toDeadUnsupported.map((r) => r.id), "unsupported_audience_for_inapp");
  if (toDeadUnsupported.length) await insertReceipts(toDeadUnsupported, false, "unsupported_audience_for_inapp");

  return { picked: rows.length, delivered };
}

/** ---- Loop contínuo ---- */
export function startDeliverInappLoop({ intervalMs = 15000 } = {}) {
  console.log(`⏱️ deliverInapp loop every ${Math.round(intervalMs / 1000)}s`);
  const tick = async () => {
    try {
      const res = await runDeliverInappOnce();
      if (res.picked) {
        console.log(`[deliverInapp] picked=${res.picked} delivered=${res.delivered}`);
      }
    } catch (e) {
      console.error("[deliverInapp] fatal:", e);
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 2000);
}
