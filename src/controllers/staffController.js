// src/controllers/staffController.js
import { sql } from "../config/db.js";

/* -------------------- Utils -------------------- */
function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || req.query.limit || 20)));
  const offset = Number.isFinite(Number(req.query.offset))
    ? Math.max(0, Number(req.query.offset))
    : (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}
const ORDER_BY_RECENTE = sql`COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) DESC, id DESC`;

const COIN_WHITELIST = ["BTC","BCH","XEC","LTC","ETC","ZEC","DASH","CKB","HNS","KAS"];
function parseCoinQuery(req) {
  const coin = String(req.query.coin || "").trim().toUpperCase();
  return coin && COIN_WHITELIST.includes(coin) ? coin : null;
}

function parseIntQP(v, def) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function parseISODate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/* -------------------- Health -------------------- */
export async function ping(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
}

/* -------------------- KPIs (ONLINE/MAINT/OFFLINE) -------------------- */
/**
 * Regras:
 *  - Se houver payload na cache (miner_status_cache), usamos:
 *      hr = max(hashrate_10min, hashrate_10m, hashrate_5m, hashrate_30m, hashrate, hr, hash)
 *      online se hr > 0
 *      maintenance se worker_status ~ 'maint*|rebooting|upgrading'
 *  - Caso contrário, caímos no campo miners.status (best effort)
 */
export async function statsMiners(_req, res) {
  try {
    const rows = await sql/*sql*/`
      WITH cache AS (
        SELECT
          m.id,
          (payload->>'hashrate_10min')::float AS hr10,
          (payload->>'hashrate_10m')::float AS hr10m,
          (payload->>'hashrate_5m')::float AS hr5,
          (payload->>'hashrate_30m')::float AS hr30,
          (payload->>'hashrate')::float AS hr,
          (payload->>'hr')::float AS hr_alt,
          (payload->>'hash')::float AS hr_alt2,
          LOWER(COALESCE(payload->>'worker_status', payload->>'status', payload->>'state')) AS ws,
          s.updated_at
        FROM miners m
        LEFT JOIN miner_status_cache s ON s.miner_id = m.id
      )
      SELECT
        COALESCE(SUM(CASE
          WHEN GREATEST(COALESCE(hr10,0),COALESCE(hr10m,0),COALESCE(hr5,0),COALESCE(hr30,0),COALESCE(hr,0),COALESCE(hr_alt,0),COALESCE(hr_alt2,0)) > 0
            THEN 1
          WHEN ws ~ '^(alive|running|ok|online|up|ativo|ligado|ativa)$'
            THEN 1
          WHEN (SELECT LOWER(COALESCE(status,'')) FROM miners WHERE id = cache.id) IN ('online','active','up','1','true')
            THEN 1
          ELSE 0
        END),0) AS online,
        COALESCE(SUM(CASE
          WHEN ws ~ '^(maint|manuten|restarting|rebooting|upgrading)'
            THEN 1
          ELSE 0
        END),0) AS maintenance,
        COUNT(*)::int AS total
      FROM cache;
    `;
    const r = rows?.[0] || {};
    const online = Number(r.online || 0);
    const maintenance = Number(r.maintenance || 0);
    const total = Number(r.total || 0);
    const offline = Math.max(0, total - online - maintenance);
    res.json({ online, offline, maintenance, total });
  } catch (err) {
    console.error("staff.statsMiners:", err);
    res.status(500).json({ error: "failed_stats_miners" });
  }
}

/* -------------------- Resumo global mês corrente -------------------- */
export async function currentSummary(_req, res) {
  try {
    const [row] = await sql/*sql*/`
      SELECT
        COALESCE(SUM(COALESCE(total_horas_online,0) * COALESCE(consumo_kw_hora,0)),0) AS total_kwh,
        COALESCE(SUM(COALESCE(total_horas_online,0)),0) AS total_hours,
        COALESCE(SUM(COALESCE(total_horas_online,0) * COALESCE(consumo_kw_hora,0) * COALESCE(preco_kw,0)),0) AS subtotal_amount
      FROM miners;
    `;
    res.json({
      total_kwh: Number(row?.total_kwh || 0),
      total_hours: Number(row?.total_hours || 0),
      subtotal_amount: Number(row?.subtotal_amount || 0),
    });
  } catch (err) {
    console.error("staff.currentSummary:", err);
    res.status(500).json({ error: "failed_current_summary" });
  }
}

/* -------------------- Lista global de faturas -------------------- */
export async function listarFaturasGlobais(req, res) {
  const includeCurrent = String(req.query.includeCurrent || req.query.include_current || "0") === "1";
  try {
    let list = [];
    try {
      list = await sql/*sql*/`
        SELECT id, year, month,
               COALESCE(subtotal_amount,0) AS subtotal_amount,
               COALESCE(status,'pendente') AS status,
               COALESCE(created_at, NOW()) AS created_at
        FROM invoices
        ORDER BY year DESC, month DESC, created_at DESC, id DESC
        LIMIT 200
      `;
    } catch {
      list = [];
    }

    if (includeCurrent) {
      try {
        const [agg] = await sql/*sql*/`
          SELECT
            COALESCE(SUM(COALESCE(total_horas_online,0) * COALESCE(consumo_kw_hora,0)),0) AS total_kwh,
            COALESCE(SUM(COALESCE(total_horas_online,0)),0) AS total_hours,
            COALESCE(SUM(COALESCE(total_horas_online,0) * COALESCE(consumo_kw_hora,0) * COALESCE(preco_kw,0)),0) AS subtotal_amount
          FROM miners;
        `;
        const now = new Date();
        const emCurso = {
          id: undefined,
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          subtotal_amount: Number(agg?.subtotal_amount || 0),
          status: "em_curso",
          created_at: now.toISOString(),
        };
        list = [emCurso, ...list];
      } catch {}
    }

    const ordered = list.slice().sort((a, b) => {
      if (a.status === "em_curso" && b.status !== "em_curso") return -1;
      if (b.status === "em_curso" && a.status !== "em_curso") return 1;
      const ca = a.created_at ? Date.parse(a.created_at) : NaN;
      const cb = b.created_at ? Date.parse(b.created_at) : NaN;
      if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return cb - ca;
      if (a.year !== b.year) return b.year - a.year;
      if (a.month !== b.month) return b.month - a.month;
      return (b.id ?? 0) - (a.id ?? 0);
    });

    res.json(ordered);
  } catch (err) {
    console.error("staff.listarFaturasGlobais:", err);
    res.status(500).json({ error: "Erro ao listar faturas globais." });
  }
}

/* -------------------- Contador global de notificações -------------------- */
export async function notificationsUnreadCount(_req, res) {
  try {
    const rows = await sql/*sql*/`
      SELECT COALESCE(COUNT(*),0) AS count
      FROM notifications
      WHERE read_at IS NULL;
    `;
    const count = Number(rows?.[0]?.count || 0);
    res.json({ count });
  } catch (_err) {
    res.json({ count: 0 });
  }
}

/* -------------------- Listagem de miners (com ETag/paginação) -------------------- */
export async function listarMinersGlobais(req, res) {
  try {
    const coin = parseCoinQuery(req);
    const { page, pageSize, offset, limit } = parsePaging(req);
    const whereCoin = coin ? sql`WHERE UPPER(coin) = ${coin}` : sql``;

    const [{ total, last_ts }] = await sql/*sql*/`
      SELECT COUNT(*)::int AS total,
             COALESCE(MAX(updated_at), MAX(created_at), NOW()) AS last_ts
      FROM miners
      ${whereCoin}
    `;
    const etag = `${total}-${new Date(last_ts).getTime()}`;
    res.setHeader("ETag", etag);

    const inm = String(req.headers["if-none-match"] || "");
    if (inm && inm === etag) return res.status(304).end();

    // Evita SELECT *: mapeia só o que o app usa
    const items = await sql/*sql*/`
      SELECT
        id,
        worker_name,
        nome,
        modelo,
        COALESCE(hash_rate, NULL) AS hash_rate,
        COALESCE(status, NULL) AS status,
        coin,
        pool,
        owner_email,
        created_at,
        updated_at
      FROM miners
      ${whereCoin}
      ORDER BY ${ORDER_BY_RECENTE}
      LIMIT ${limit} OFFSET ${offset}
    `;

    res.json({ items, total: total ?? items.length, page, pageSize });
  } catch (err) {
    console.error("staff.listarMinersGlobais:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao listar miners (staff)." });
  }
}

/* -------------------- Status helpers -------------------- */
/**
 * 🔥 O teu frontend espera payload com campos usados no cálculo:
 *  - hashrate_10min / 10m / 5m / 30m / hashrate / hr / hash
 *  - worker_status
 *  - power / watts
 * Devolve isso da TABELA DE CACHE (jsonb). Se não existir, cai para miners.status minimal.
 */
export async function obterStatusBatch(req, res) {
  try {
    const raw = String(req.query.ids || "").trim();
    const ids = raw ? raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.json([]);

    const MAX_IDS = 500;
    const idsCapped = ids.slice(0, MAX_IDS);

    const rows = await sql/*sql*/`
      SELECT
        m.id,
        c.payload,
        m.status AS fallback_status
      FROM miners m
      LEFT JOIN miner_status_cache c ON c.miner_id = m.id
      WHERE m.id = ANY(${sql.array(idsCapped)})
      ORDER BY m.id ASC
    `;

    const out = rows.map((r) => {
      const id = Number(r.id);
      const payload = r.payload || null;
      if (payload && typeof payload === "object") {
        return {
          id,
          hashrate_10min: Number(payload.hashrate_10min ?? payload.hashrate_10m ?? payload.hashrate ?? payload.hr ?? payload.hash ?? 0) || 0,
          worker_status: String(payload.worker_status ?? payload.status ?? payload.state ?? ""),
          power: payload.power ?? payload.watts ?? null,
          watts: payload.watts ?? payload.power ?? null,
          // devolve tudo para o app ter liberdade
          ...payload,
        };
      }
      // fallback minimal
      return {
        id,
        hashrate_10min: 0,
        worker_status: String(r.fallback_status ?? "offline"),
        power: null,
        watts: null,
      };
    });

    return res.json(out);
  } catch (err) {
    console.error("staff.obterStatusBatch:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || "Erro ao obter status (batch)." });
  }
}

export async function obterStatusPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    const rows = await sql/*sql*/`
      SELECT
        m.id,
        c.payload,
        m.status AS fallback_status
      FROM miners m
      LEFT JOIN miner_status_cache c ON c.miner_id = m.id
      WHERE m.id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrada." });
    const r = rows[0];
    const payload = r.payload || null;

    if (payload && typeof payload === "object") {
      return res.json({
        id: Number(r.id),
        hashrate_10min: Number(payload.hashrate_10min ?? payload.hashrate_10m ?? payload.hashrate ?? payload.hr ?? payload.hash ?? 0) || 0,
        worker_status: String(payload.worker_status ?? payload.status ?? payload.state ?? ""),
        power: payload.power ?? payload.watts ?? null,
        watts: payload.watts ?? payload.power ?? null,
        ...payload,
      });
    }
    return res.json({
      id: Number(r.id),
      hashrate_10min: 0,
      worker_status: String(r.fallback_status ?? "offline"),
      power: null,
      watts: null,
    });
  } catch (err) {
    console.error("staff.obterStatusPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao obter status." });
  }
}

/* -------------------- Miner State Events -------------------- */
export async function listarMinerStateEvents(req, res) {
  try {
    const page = parseIntQP(req.query.page, 1);
    const pageSize = Math.min(200, parseIntQP(req.query.pageSize ?? req.query.limit, 30));
    const offset =
      req.query.offset != null
        ? Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0)
        : (page - 1) * pageSize;

    const minerId = req.query.minerId != null ? Number.parseInt(String(req.query.minerId), 10) : null;
    const from = parseISODate(req.query.from);
    const to = parseISODate(req.query.to);
    const state = String(req.query.state || "").trim().toUpperCase();
    const order = String(req.query.order || "desc").toLowerCase() === "asc" ? sql`ASC` : sql`DESC`;

    const where = [];
    if (Number.isFinite(minerId)) where.push(sql`miner_id = ${minerId}`);
    if (from) where.push(sql`occurred_at_utc >= ${from.toISOString()}`);
    if (to) where.push(sql`occurred_at_utc <= ${to.toISOString()}`);
    if (state && ["ONLINE","OFFLINE","MAINTENANCE","STALE"].includes(state)) {
      where.push(sql`UPPER(to_state) = ${state}`);
    }

    const whereSql = where.length ? where.reduce((acc, frag, i) => (i ? sql`${acc} AND ${frag}` : frag), sql``) : sql`TRUE`;

    const [items, totalRow] = await Promise.all([
      sql/*sql*/`
        SELECT id, miner_id, from_state, to_state, slot_iso, occurred_at_utc, reason
        FROM miner_state_events
        WHERE ${whereSql}
        ORDER BY occurred_at_utc ${order}, id ${order}
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      sql/*sql*/`
        SELECT COUNT(*)::int AS total
        FROM miner_state_events
        WHERE ${whereSql}
      `,
    ]);

    res.json({
      items,
      page,
      pageSize,
      total: totalRow?.[0]?.total ?? items.length,
    });
  } catch (err) {
    console.error("staff.listarMinerStateEvents:", err);
    res.status(500).json({ error: "Erro ao listar eventos." });
  }
}
