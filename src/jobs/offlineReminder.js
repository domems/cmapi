// src/jobs/offlineReminder.js
import { sql } from "../config/db.js";
const asRows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

/** Arredonda timestamp para a janela (p.ex. 120 min) para dedupe */
function floorWindowISO(now, minutes) {
  const ms = Math.max(1, minutes) * 60000;
  const w = new Date(Math.floor(now.getTime() / ms) * ms);
  return w.toISOString();
}

/** Prefs helpers — tolerantes a esquemas diferentes */
async function userAllows(userId, template /* 'miner_offline_reminder' */) {
  const keys = [template, "miner_status_offline"];
  const rows = asRows(await sql/*sql*/`
    SELECT key, enabled
    FROM user_notification_prefs
    WHERE user_id = ${userId} AND key = ANY(${keys})
  `);
  if (!rows.length) return true; // default ON
  return rows.some((r) => r.enabled === true);
}

/** Cooldown (min) por user; tenta várias formas; default 120 */
async function getCooldownMinutes(userId, fallback = 120) {
  const v1 = asRows(await sql/*sql*/`
    SELECT COALESCE(NULLIF(value_num, 0),
                    NULLIF((NULLIF(value, '')::int), 0)) AS v
    FROM user_notification_prefs
    WHERE user_id=${userId}
      AND key IN ('miner_offline_cooldown_min','miner_offline_cooldown')
    ORDER BY key
    LIMIT 1
  `)[0]?.v;
  if (typeof v1 === "number" && Number.isFinite(v1)) return Math.max(1, Math.trunc(v1));

  const v2 = asRows(await sql/*sql*/`
    SELECT (payload_json->>'minutes')::int AS v
    FROM user_notification_prefs
    WHERE user_id=${userId}
      AND key IN ('miner_offline_cooldown_min','miner_offline_cooldown')
      AND (payload_json->>'minutes') IS NOT NULL
    LIMIT 1
  `)[0]?.v;
  if (typeof v2 === "number" && Number.isFinite(v2)) return Math.max(1, Math.trunc(v2));

  return Math.max(1, Math.trunc(fallback));
}

/** Uma passagem: cria reminders para miners OFFLINE há mais que o cooldown */
export async function runOfflineReminderOnce() {
  const now = new Date();

  const rows = asRows(await sql/*sql*/`
    SELECT ms.miner_id,
           m.user_id,
           m.worker_name,
           ms.stable_since_utc
    FROM miner_state ms
    JOIN miners m ON m.id = ms.miner_id
    WHERE ms.current_state = 'OFFLINE'
  `);

  let enqueued = 0;

  for (const r of rows) {
    const wants = await userAllows(r.user_id, "miner_offline_reminder");
    if (!wants) continue;

    const cooldown = await getCooldownMinutes(r.user_id, 120);
    const minutesOffline = (now.getTime() - new Date(r.stable_since_utc).getTime()) / 60000;
    if (minutesOffline < cooldown) continue;

    // evita spam: check pelo que já FOI enviado recentemente
    const exists = asRows(await sql/*sql*/`
      SELECT 1
      FROM notification_outbox
      WHERE channel='push'
        AND template='miner_offline_reminder'
        AND status IN ('pending','sent')
        AND (payload_json->>'minerId')::bigint = ${r.miner_id}
        AND sent_at > NOW() - (${cooldown}::int || ' minutes')::interval
      LIMIT 1
    `)[0];
    if (exists) continue;

    const dedupeKey = `miner:${r.miner_id}:offline_reminder:${floorWindowISO(now, cooldown)}`;
    const payload = {
      minerId: r.miner_id,
      worker: r.worker_name || null,
      sinceUtc: new Date(r.stable_since_utc).toISOString(),
      atUtc: now.toISOString(),
      cooldownMin: cooldown,
    };

    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${dedupeKey}, 'user', ${r.user_id}, 'push', 'miner_offline_reminder', ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
    enqueued++;
  }

  return { scanned: rows.length, enqueued };
}

/** Loop contínuo (export que FALTOU no teu build) */
export function startOfflineReminderLoop({ intervalMs = 60_000 } = {}) {
  console.log(`⏱️ offlineReminder loop every ${Math.round(intervalMs / 1000)}s`);
  const tick = async () => {
    try {
      const r = await runOfflineReminderOnce();
      if (r.scanned) console.log(`[offlineReminder] scanned=${r.scanned} enqueued=${r.enqueued}`);
    } catch (e) {
      console.error("[offlineReminder] fatal:", e);
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 2000);
}

/** CLI runner continua OK */
if (import.meta.url === `file://${process.argv[1]}`) {
  runOfflineReminderOnce()
    .then((r) => { console.log(`[offlineReminder] scanned=${r.scanned} enqueued=${r.enqueued}`); process.exit(0); })
    .catch((e) => { console.error("[offlineReminder] ERRO:", e); process.exit(1); });
}
