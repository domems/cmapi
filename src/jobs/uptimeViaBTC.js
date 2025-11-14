// src/jobs/uptimeViaBTC.js
import cron from "node-cron";
import fetchOrig from "node-fetch";
import { sql } from "../config/db.js";

/* =============================== */
/* Config de debug                 */
/* =============================== */
const TAG = "[uptime:viabtc]";
const DEBUG = (process.env.DEBUG_UPTIME_VIABTC ?? "true").toLowerCase() === "true";

/* =============================== */
/* Utils gerais                    */
/* =============================== */
const fetch = globalThis.fetch || fetchOrig;

function slotISO(d = new Date()) {
  const m = d.getUTCMinutes();
  const q = m - (m % 15);
  const t = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      q,
      0
    )
  );
  return t.toISOString();
}

// ===== helpers =====
const norm = (s) => String(s ?? "").trim();
const low  = (s) => norm(s).toLowerCase();
/** usa só o sufixo depois do último "." (mantém zeros à esquerda) */
const tail = (s) => {
  const str = norm(s);
  const i = str.lastIndexOf(".");
  return i >= 0 ? str.slice(i + 1) : str;
};
function normalizeCoin(c) {
  const s = String(c ?? "").trim().toUpperCase();
  // Mantendo a tua restrição original; se quiseres outras, adiciona aqui.
  return s === "BTC" || s === "LTC" ? s : "";
}
/** estado online sem falsos positivos (ex.: "unactive" NÃO é "active") */
function isOnlineFrom(w) {
  const hr = Number(w?.hashrate_10min ?? 0);
  if (Number.isFinite(hr) && hr > 0) return true;
  const ws = low(w?.worker_status ?? "");
  const NEG = new Set(["unactive", "inactive", "offline", "down", "dead"]);
  if (NEG.has(ws)) return false;
  const POS = new Set(["active", "online", "alive", "running", "up", "ok"]);
  if (POS.has(ws)) return true;
  return false;
}

function maskKey(k) {
  const s = String(k ?? "");
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/* =============================== */
/* API fetch + caches              */
/* =============================== */
const API_TTL_MS = 60_000; // cache em memória por grupo (api_key|coin)
const API_TIMEOUT_MS = 12_000;

const apiCache = new Map(); // key -> { workers, ts }
let lastSlot = null;
let slotCache = new Map();  // `${slot}|${api_key}|${coin}` -> workers
const updatedInSlot = new Set();

function beginSlot(s) {
  if (s !== lastSlot) {
    if (DEBUG) {
      console.log(`${TAG} novo slot`, { prev: lastSlot, next: s });
    }
    lastSlot = s;
    slotCache = new Map();     // limpa cache do slot quando muda
    updatedInSlot.clear();     // mantém dedupe de incrementos por slot
  }
}
function dedupe(ids) {
  const out = [];
  for (const id of ids) {
    if (!updatedInSlot.has(id)) {
      updatedInSlot.add(id);
      out.push(id);
    }
  }
  return out;
}

async function fetchViaBTCList(apiKey, coin) {
  const url = `https://www.viabtc.net/res/openapi/v1/hashrate/worker?coin=${coin}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), API_TIMEOUT_MS);

  const maskedKey = maskKey(apiKey);

  try {
    if (DEBUG) {
      console.log(`${TAG} FETCH START`, { url, coin, apiKey: maskedKey });
    }

    const resp = await fetch(url, {
      headers: { "X-API-KEY": apiKey },
      signal: ac.signal,
    });

    const httpStatus = resp.status;

    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      console.error(`${TAG} FETCH JSON ERROR`, {
        url,
        coin,
        apiKey: maskedKey,
        httpStatus,
        error: e?.message || String(e),
      });
      return [];
    }

    if (!data) {
      console.error(`${TAG} FETCH EMPTY DATA`, {
        url,
        coin,
        apiKey: maskedKey,
        httpStatus,
      });
      return [];
    }

    if (data.code !== 0) {
      console.error(`${TAG} FETCH CODE != 0`, {
        url,
        coin,
        apiKey: maskedKey,
        httpStatus,
        code: data.code,
        msg: data.msg,
      });
      return [];
    }

    if (!Array.isArray(data.data?.data)) {
      console.error(`${TAG} FETCH BAD SHAPE`, {
        url,
        coin,
        apiKey: maskedKey,
        httpStatus,
        hasData: !!data.data,
        keys: Object.keys(data || {}),
        dataKeys: data.data ? Object.keys(data.data) : null,
      });
      return [];
    }

    const workers = data.data.data.map((w) => ({
      worker_name: String(w.worker_name ?? ""),
      worker_status: String(w.worker_status ?? ""),
      hashrate_10min: Number(w.hashrate_10min ?? 0),
    }));

    if (DEBUG) {
      console.log(`${TAG} FETCH OK`, {
        url,
        coin,
        apiKey: maskedKey,
        httpStatus,
        nWorkers: workers.length,
        sample: workers.slice(0, 3),
      });
    }

    return workers;
  } catch (e) {
    console.error(`${TAG} FETCH ERROR`, {
      url,
      coin,
      apiKey: maskedKey,
      error: e?.message || String(e),
    });
    return [];
  } finally {
    clearTimeout(to);
  }
}

/**
 * Obtém workers da ViaBTC para (apiKey, coin) com 2 camadas de cache:
 *  - cache do SLOT atual (reutiliza dentro do mesmo slot de 15 min)
 *  - cache temporário em memória com TTL (evita refetchs em execuções próximas)
 * Retorna { workers, cache: "slot"|"memory"|"miss" }
 */
async function getViaBTCWorkersCached(apiKey, coin, slot) {
  const groupKey = `${apiKey}|${coin}`;
  const slotKey  = `${slot}|${groupKey}`;
  const maskedKey = maskKey(apiKey);

  // 1) cache por slot (mais forte)
  if (slotCache.has(slotKey)) {
    const workers = slotCache.get(slotKey) || [];
    if (DEBUG) {
      console.log(`${TAG} CACHE HIT (slot)`, {
        coin,
        apiKey: maskedKey,
        slot,
        nWorkers: workers.length,
      });
    }
    return { workers, cache: "slot" };
  }

  // 2) cache com TTL
  const c = apiCache.get(groupKey);
  if (c && Date.now() - c.ts < API_TTL_MS) {
    slotCache.set(slotKey, c.workers);
    if (DEBUG) {
      console.log(`${TAG} CACHE HIT (memory)`, {
        coin,
        apiKey: maskedKey,
        slot,
        ageMs: Date.now() - c.ts,
        nWorkers: c.workers.length,
      });
    }
    return { workers: c.workers, cache: "memory" };
  }

  // 3) fetch real
  if (DEBUG) {
    console.log(`${TAG} CACHE MISS`, { coin, apiKey: maskedKey, slot });
  }
  const workers = await fetchViaBTCList(apiKey, coin);
  apiCache.set(groupKey, { workers, ts: Date.now() });
  slotCache.set(slotKey, workers);
  return { workers, cache: "miss" };
}

/* ===== Bloqueio manutenção (status DB) ===== */
const IS_NOT_MAINT = sql`AND lower(COALESCE(status, '')) <> 'maintenance'`;

/* =============================== */
/* Job principal                   */
/* =============================== */
export async function runUptimeViaBTCOnce() {
  const t0 = Date.now();
  const sISO = slotISO();
  beginSlot(sISO);

  let updated = 0;
  let totalMiners = 0;
  let totalGroups = 0;
  let workersRelevant = 0;
  let workersExtra = 0;
  let groupErrors = 0;
  let apiCalls = 0;

  // contadores de alterações de status
  let statusToOnline = 0;
  let statusToOffline = 0;

  // concorrência REAL
  const CONCURRENCY = 3;
  const inflight = new Set();
  const allTasks = [];

  try {
    // agrupar por (api_key, coin normalizada)
    const minersRaw = await sql/*sql*/`
      SELECT id, worker_name, api_key, coin
      FROM miners
      WHERE pool = 'ViaBTC' AND api_key IS NOT NULL AND worker_name IS NOT NULL
    `;

    if (DEBUG) {
      console.log(`${TAG} DB MINERS RAW`, {
        count: minersRaw.length,
        sample: minersRaw.slice(0, 5),
      });
    }

    const miners = minersRaw
      .map(m => ({ ...m, coin: normalizeCoin(m.coin) }))
      .filter(m => m.coin);
    totalMiners = miners.length;

    if (DEBUG) {
      console.log(`${TAG} DB MINERS NORMALIZED`, {
        totalMiners,
        coins: Array.from(new Set(miners.map(m => m.coin))),
      });
    }

    if (!totalMiners) {
      console.log(
        `${TAG} ${sISO} groups=0 miners=0 api=0 workers=0 extra=0 online=0 errs=0 statusOn=0 statusOff=0 dur=${Date.now() - t0}ms`
      );
      return { ok: true, updated: 0 };
    }

    const groups = new Map(); // `${api_key}|${coin}` -> Miner[]
    for (const m of miners) {
      const k = `${m.api_key}|${m.coin}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    totalGroups = groups.size;

    if (DEBUG) {
      console.log(`${TAG} GROUPS BUILT`, {
        totalGroups,
        groups: Array.from(groups.entries()).map(([k, list]) => ({
          key: k,
          apiKey: maskKey(list[0]?.api_key),
          coin: list[0]?.coin,
          miners: list.map(m => ({ id: m.id, worker_name: m.worker_name })),
        })),
      });
    }

    const groupEntries = Array.from(groups.entries());

    const processGroup = async ([k, list]) => {
      const [apiKey, coin] = k.split("|");
      const maskedKey = maskKey(apiKey);

      try {
        if (DEBUG) {
          console.log(`${TAG} GROUP START`, {
            apiKey: maskedKey,
            coin,
            miners: list.map(m => ({
              id: m.id,
              worker_name: m.worker_name,
              tail: tail(m.worker_name),
            })),
          });
        }

        // mapa tail -> [ids]
        const tailToIds = new Map();
        for (const m of list) {
          const t = tail(m.worker_name);
          if (!t) continue;
          if (!tailToIds.has(t)) tailToIds.set(t, []);
          tailToIds.get(t).push(m.id);
        }
        const tailsWanted = new Set(tailToIds.keys());
        const allIds = list.map(m => m.id);

        if (DEBUG) {
          console.log(`${TAG} GROUP MAP`, {
            apiKey: maskedKey,
            coin,
            tailsWanted: Array.from(tailsWanted),
            allIds,
          });
        }

        // fetch (com caches)
        const { workers, cache } = await getViaBTCWorkersCached(apiKey, coin, sISO);
        if (cache === "miss") apiCalls += 1;

        if (DEBUG) {
          console.log(`${TAG} GROUP FETCH RESULT`, {
            apiKey: maskedKey,
            coin,
            cache,
            nWorkers: workers.length,
            sample: workers.slice(0, 5),
          });
        }

        // filtrar apenas relevantes para a BD
        const relevant = [];
        let extra = 0;
        for (const w of workers) {
          const tw = tail(w.worker_name);
          if (tailsWanted.has(tw)) relevant.push(w);
          else extra += 1;
        }
        workersRelevant += relevant.length;
        workersExtra += extra;

        if (DEBUG) {
          console.log(`${TAG} GROUP RELEVANT`, {
            apiKey: maskedKey,
            coin,
            relevant: relevant.map(w => ({
              worker_name: w.worker_name,
              tail: tail(w.worker_name),
              hashrate_10min: w.hashrate_10min,
              worker_status: w.worker_status,
              online: isOnlineFrom(w),
            })),
            extra,
          });
        }

        // determinar online e acumular ids
        const onlineIdsRaw = [];
        for (const w of relevant) {
          if (!isOnlineFrom(w)) continue;
          const ids = tailToIds.get(tail(w.worker_name)) || [];
          onlineIdsRaw.push(...ids);
        }

        const onlineSet = new Set(onlineIdsRaw);
        const offlineIdsRaw = allIds.filter(id => !onlineSet.has(id));

        if (DEBUG) {
          console.log(`${TAG} GROUP ONLINE/OFFLINE`, {
            apiKey: maskedKey,
            coin,
            onlineIdsRaw,
            offlineIdsRaw,
          });
        }

        // 1) Horas online (dedupe por slot) — NÃO contar se em manutenção
        const ids = dedupe(onlineIdsRaw);
        if (ids.length) {
          if (DEBUG) {
            console.log(`${TAG} GROUP HOURS UPDATE`, {
              apiKey: maskedKey,
              coin,
              ids,
              inc: 0.25,
            });
          }
          await sql/*sql*/`
            UPDATE miners
            SET total_horas_online = COALESCE(total_horas_online,0) + 0.25
            WHERE id = ANY(${ids})
              ${IS_NOT_MAINT}
          `;
          updated += ids.length;
        }

        // 2) Status (IGNORAR manutenção; só altera quando diverge)
        if (onlineIdsRaw.length) {
          const r1 = await sql/*sql*/`
            UPDATE miners
            SET status = 'online'
            WHERE id = ANY(${onlineIdsRaw})
              AND status IS DISTINCT FROM 'online'
              ${IS_NOT_MAINT}
            RETURNING id
          `;
          const n1 = Array.isArray(r1) ? r1.length : (r1?.count || 0);
          statusToOnline += n1;
          if (DEBUG && n1 > 0) {
            console.log(`${TAG} GROUP STATUS->ONLINE`, {
              apiKey: maskedKey,
              coin,
              count: n1,
            });
          }
        }
        if (offlineIdsRaw.length) {
          const r2 = await sql/*sql*/`
            UPDATE miners
            SET status = 'offline'
            WHERE id = ANY(${offlineIdsRaw})
              AND status IS DISTINCT FROM 'offline'
              ${IS_NOT_MAINT}
            RETURNING id
          `;
          const n2 = Array.isArray(r2) ? r2.length : (r2?.count || 0);
          statusToOffline += n2;
          if (DEBUG && n2 > 0) {
            console.log(`${TAG} GROUP STATUS->OFFLINE`, {
              apiKey: maskedKey,
              coin,
              count: n2,
            });
          }
        }
      } catch (err) {
        groupErrors += 1;
        console.error(`${TAG} group error ${k}:`, err?.message || err);
      }
    };

    // Pool de concorrência
    for (const entry of groupEntries) {
      const task = (async () => await processGroup(entry))();
      allTasks.push(task);
      inflight.add(task);
      task.finally(() => inflight.delete(task));

      if (inflight.size >= CONCURRENCY) {
        // Espera uma terminar antes de lançar mais
        await Promise.race(inflight).catch(() => {});
      }
    }

    // Espera tudo fechar
    await Promise.allSettled(allTasks);

    console.log(
      `${TAG} ${sISO} groups=${totalGroups} miners=${totalMiners} api=${apiCalls} workers=${workersRelevant} extra=${workersExtra} online(+hrs)=${updated} statusOn=${statusToOnline} statusOff=${statusToOffline} errs=${groupErrors} dur=${Date.now() - t0}ms`
    );
    return {
      ok: true,
      updated, // nº de miners a quem somámos 0.25h
      statusChanged: statusToOnline + statusToOffline,
      statusToOnline,
      statusToOffline,
      groups: totalGroups,
      miners: totalMiners,
      api: apiCalls,
      workers_relevant: workersRelevant,
      workers_extra: workersExtra,
      errs: groupErrors
    };
  } catch (e) {
    console.error(`${TAG} ${sISO} ERROR:`, e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/* =============================== */
/* Scheduler                       */
/* =============================== */
export function startUptimeViaBTC() {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try { await runUptimeViaBTCOnce(); } catch (e) { console.error(`${TAG} tick error:`, e?.message || e); }
    },
    { timezone: "Europe/Lisbon" }
  );
  console.log("[jobs] ViaBTC (*/15) agendado.");
}
