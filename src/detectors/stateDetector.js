// src/detectors/stateDetector.js
import { sql } from "../config/db.js";
const asRows = (res) => (Array.isArray(res) ? res : (res?.rows ?? []));

/** Canonical: ONLINE | OFFLINE | STALE */
function canonicalStateFromStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const ONLINE  = ["online","on","active","ativo","ativa","working","running","normal","ok","up","alive","mining","hashing","ligado"];
  const OFFLINE = ["offline","off","inactive","inativo","inactiva","down","dead","stopped","error","erro","disabled","paused","fail","ko","desligado"];
  if (ONLINE.some(k => s.includes(k))) return "ONLINE";
  if (OFFLINE.some(k => s.includes(k))) return "OFFLINE";
  return "STALE";
}

/** slot ISO (15m) p/ dedupe/agrupamento */
function slotISO(d = new Date()) {
  const m = d.getUTCMinutes(), q = m - (m % 15);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0));
  return t.toISOString();
}

async function getCurrentState(minerId) {
  const r = asRows(await sql/*sql*/`
    SELECT current_state, stable_since_utc, last_seen_utc, last_hashrate
    FROM miner_state
    WHERE miner_id = ${minerId}
  `);
  return r[0] || null;
}

export async function processMiner(minerId) {
  // status + dono + worker
  const minerRows = asRows(await sql/*sql*/`
    SELECT id, status, user_id, worker_name
    FROM miners
    WHERE id = ${minerId}
  `);
  const miner = minerRows[0];
  if (!miner) return { changed: false, reason: "miner_not_found" };

  const next = canonicalStateFromStatus(miner.status);
  const prevRow = await getCurrentState(minerId);
  const prev = prevRow?.current_state || null;

  const now = new Date();
  const sISO = slotISO(now);

  // Primeira vez: sem evento; só semear
  if (!prev) {
    await sql/*sql*/`
      INSERT INTO miner_state (miner_id, current_state, stable_since_utc, last_change_utc, last_seen_utc, last_hashrate, flap_count)
      VALUES (${minerId}, ${next}, ${now}, ${now}, ${now}, 0, 0)
      ON CONFLICT (miner_id) DO UPDATE
      SET current_state    = EXCLUDED.current_state,
          last_change_utc  = EXCLUDED.last_change_utc,
          stable_since_utc = EXCLUDED.stable_since_utc,
          last_seen_utc    = EXCLUDED.last_seen_utc
    `;
    return { changed: false, from: null, to: next };
  }

  if (prev === next) {
    await sql/*sql*/`UPDATE miner_state SET last_seen_utc = ${now} WHERE miner_id = ${minerId}`;
    return { changed: false, from: prev, to: next };
  }

  // Mudou → evento + update + outbox
  const shouldNotifyUser =
    (prev !== "OFFLINE" && next === "OFFLINE") ||
    (prev !== "ONLINE"  && next === "ONLINE");

  // 1) evento
  await sql/*sql*/`
    INSERT INTO miner_state_events (miner_id, from_state, to_state, slot_iso, reason)
    VALUES (${minerId}, ${prev}, ${next}, ${sISO}, ${prev}||'→'||${next})
    ON CONFLICT DO NOTHING
  `;

  // 2) estado atual
  await sql/*sql*/`
    UPDATE miner_state
    SET current_state    = ${next},
        last_change_utc  = ${now},
        stable_since_utc = CASE WHEN current_state <> ${next} THEN ${now} ELSE stable_since_utc END,
        last_seen_utc    = ${now}
    WHERE miner_id = ${minerId}
  `;

  // 3) notificações (SEM prefs aqui — sempre enfileira)
  if (shouldNotifyUser) {
    const template = next === "OFFLINE" ? "miner_offline" : "miner_recovered";
    const baseKey    = `miner:${minerId}:${prev}->${next}:${sISO}`;
    const inappKey   = baseKey;                    // dedupe in-app
    const pushKey    = `${baseKey}:push`;          // dedupe push
    const adminKey   = `${baseKey}:role:admin:push`;
    const supportKey = `${baseKey}:role:support:push`;

    const payload = {
      minerId,
      worker: miner.worker_name || null,
      from: prev,
      to: next,
      slot: sISO,
      atUtc: now.toISOString()
    };

    // Dono: enfileira SEMPRE (dispatcher decide entregar ou matar por prefs)
    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${inappKey}, 'user', ${miner.user_id}, 'inapp', ${template}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${pushKey}, 'user', ${miner.user_id}, 'push', ${template}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    // Escalação só para OFFLINE (fica enfileirada; dispatcher trata)
    if (next === "OFFLINE") {
      await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json, send_after_utc)
        VALUES
          (${adminKey}, 'role', 'admin', 'push', ${template}, ${JSON.stringify(payload)}::jsonb, NOW() + INTERVAL '60 minutes')
        ON CONFLICT (dedupe_key) DO NOTHING
      `;
      await sql/*sql*/`
        INSERT INTO notification_outbox
          (dedupe_key, audience_kind, audience_ref, channel, template, payload_json, send_after_utc)
        VALUES
          (${supportKey}, 'role', 'support', 'push', ${template}, ${JSON.stringify(payload)}::jsonb, NOW() + INTERVAL '180 minutes')
        ON CONFLICT (dedupe_key) DO NOTHING
      `;
    }

    // Se recuperou, mata escalations/reminders pendentes
    if (next === "ONLINE") {
      await sql/*sql*/`
        UPDATE notification_outbox
        SET status='dead'
        WHERE status='pending'
          AND (
               (audience_kind='role' AND channel='push' AND template='miner_offline')
            OR (audience_kind='user' AND channel='push' AND template='miner_offline_reminder')
          )
          AND (payload_json->>'minerId')::bigint = ${minerId}
      `;
    }
  }

  return { changed: true, from: prev, to: next };
}

export async function detectAllOnce() {
  const miners = asRows(await sql/*sql*/`SELECT id FROM miners ORDER BY id`);
  let changed = 0, total = 0;
  for (const m of miners) {
    total++;
    const res = await processMiner(m.id);
    if (res.changed) changed++;
  }
  return { total, changed };
}
