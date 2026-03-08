import { sql } from "../config/db.js";
import { getClerkUserById } from "../services/clerkUserService.js";

/* ---------- Utils ---------- */
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
function numFromText(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}
function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}
function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function pickPrimaryEmailFromClerkUser(user) {
  const arr = Array.isArray(user?.email_addresses) ? user.email_addresses : [];
  const primaryId = user?.primary_email_address_id || null;
  if (primaryId) {
    const hit = arr.find((e) => e?.id === primaryId);
    if (hit?.email_address) return String(hit.email_address).toLowerCase();
  }
  return arr[0]?.email_address ? String(arr[0].email_address).toLowerCase() : null;
}
function userDisplayFromClerk(user) {
  if (!user || typeof user !== "object") return { name: null, email: null };
  const first = String(user.first_name || "").trim();
  const last = String(user.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ").trim() || user.username || null;
  const email = pickPrimaryEmailFromClerkUser(user);
  return { name: name || null, email: email || null };
}

/* ---------- Health ---------- */
export async function ping(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
}

/* ---------- KPIs globais (direto da tabela MINERS) ---------- */
/** Regras:
 * - ONLINE se hash_rate numérico > 0 OU status em ['online','active','up','1','true']
 * - MAINT se status ~ 'maint'/'manuten'/'rebooting'/'upgrading'
 * - OFFLINE = total - online - maintenance
 */
export async function statsMiners(_req, res) {
  try {
    const rows = await sql/*sql*/`
      SELECT
        COUNT(*)::int AS total,
        SUM(
          CASE
            WHEN NULLIF(TRIM(hash_rate), '') IS NOT NULL
             AND hash_rate ~ '^[0-9]+([.,][0-9]+)?$'
             AND REPLACE(hash_rate, ',', '.')::double precision > 0
              THEN 1
            WHEN LOWER(COALESCE(status,'')) IN ('online','active','up','1','true')
              THEN 1
            ELSE 0
          END
        )::int AS online,
        SUM(
          CASE
            WHEN LOWER(COALESCE(status,'')) ~ '^(maint|manuten|restarting|rebooting|upgrading)'
              THEN 1
            ELSE 0
          END
        )::int AS maintenance
      FROM miners;
    `;
    const r = rows?.[0] || {};
    const total = Number(r.total || 0);
    const online = Number(r.online || 0);
    const maintenance = Number(r.maintenance || 0);
    const offline = Math.max(0, total - online - maintenance);
    res.json({ online, offline, maintenance, total });
  } catch (err) {
    console.error("staff.statsMiners:", err);
    res.status(500).json({ error: "failed_stats_miners" });
  }
}


/* ---------- Resumo mês corrente (direto da tabela) ---------- */
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

/* ---------- Lista global de faturas (+ em_curso opcional) ---------- */
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
        list = [{
          id: undefined,
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          subtotal_amount: Number(agg?.subtotal_amount || 0),
          status: "em_curso",
          created_at: now.toISOString(),
        }, ...list];
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

/* ---------- Notificações por ler ---------- */
export async function notificationsUnreadCount(_req, res) {
  try {
    const rows = await sql/*sql*/`
      SELECT COALESCE(COUNT(*),0) AS count
      FROM notifications
      WHERE read_at IS NULL;
    `;
    res.json({ count: Number(rows?.[0]?.count || 0) });
  } catch {
    res.json({ count: 0 });
  }
}

/* ---------- Listagem de miners (ETag + paginação) ---------- */
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
    if (String(req.headers["if-none-match"] || "") === etag) return res.status(304).end();

    // Apenas campos que EXISTEM na tua tabela
    const items = await sql/*sql*/`
      SELECT
        id,
        user_id,
        nome,
        modelo,
        hash_rate,
        worker_name,
        status,
        preco_kw,
        consumo_kw_hora,
        coin,
        pool,
        locked,
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
    res.status(500).json({ error: "Erro ao listar miners (staff)." });
  }
}

/* ---------- Status helpers (sem cache; direto da tabela) ---------- */
/** Frontend espera algo tipo:
 *   { id, hashrate_10min, worker_status, power, watts, ... }
 * Aqui: hashrate_10min = parse(hash_rate TEXT)
 *       worker_status  = status TEXT
 *       power/watts    = null (não tens colunas para isto)
 */
export async function obterStatusBatch(req, res) {
  try {
    const raw = String(req.query.ids || "").trim();
    const ids = raw
      ? raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [];
    if (!ids.length) return res.json([]);

    const MAX_IDS = 500;
    const idsCapped = ids.slice(0, MAX_IDS);

    const rows = await sql.unsafe(
      `
        SELECT id, hash_rate, status
        FROM miners
        WHERE id = ANY($1::int[])
        ORDER BY id ASC
      `,
      [idsCapped]
    );

    const out = (Array.isArray(rows) ? rows : rows?.rows || []).map((r) => {
      const hrText = r.hash_rate ?? "";
      const hr =
        typeof hrText === "string" && /^[0-9]+([.,][0-9]+)?$/.test(hrText)
          ? Number(hrText.replace(",", "."))
          : 0;
      return {
        id: Number(r.id),
        hashrate_10min: Number.isFinite(hr) ? hr : 0,
        worker_status: String(r.status ?? ""),
        power: null,
        watts: null,
      };
    });

    return res.json(out);
  } catch (err) {
    console.error("staff.obterStatusBatch:", err);
    return res.status(500).json({ error: err.message || "Erro ao obter status (batch)." });
  }
}



export async function obterStatusPorId(req, res) {
  try {
    const id = parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

    const rows = await sql/*sql*/`
      SELECT id, hash_rate, status
      FROM miners
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrada." });

    const r = rows[0];
    const hr = numFromText(r.hash_rate);
    const ws = String(r.status ?? "");

    return res.json({
      id: Number(r.id),
      hashrate_10min: hr,
      worker_status: ws,
      power: null,
      watts: null,
    });
  } catch (err) {
    console.error("staff.obterStatusPorId:", err);
    res.status(500).json({ error: err.message || "Erro ao obter status." });
  }
}

/* ---------- Miner State Events (mantém) ---------- */
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
    const whereSql = where.length
      ? where.reduce((acc, frag, i) => (i ? sql`${acc} AND ${frag}` : frag), sql``)
      : sql`TRUE`;

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

    res.json({ items, page, pageSize, total: totalRow?.[0]?.total ?? items.length });
  } catch (err) {
    console.error("staff.listarMinerStateEvents:", err);
    res.status(500).json({ error: "Erro ao listar eventos." });
  }
}

/* ---------- Resumo mensal de offline por user/miner ---------- */
export async function offlineSummaryByMonth(req, res) {
  try {
    const now = new Date();
    const year = clampInt(req.query.year, 2000, 2100, now.getUTCFullYear());
    const month = clampInt(req.query.month, 1, 12, now.getUTCMonth() + 1);

    const startUtc = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const endUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    if (!(startUtc < endUtc)) {
      return res.status(400).json({ error: "invalid_month_range" });
    }

    const perMiner = await sql/*sql*/`
      WITH month_bounds AS (
        SELECT ${startUtc.toISOString()}::timestamptz AS month_start,
               ${endUtc.toISOString()}::timestamptz AS month_end
      ),
      miners_scope AS (
        SELECT
          m.id AS miner_id,
          m.user_id::text AS user_id,
          NULLIF(TRIM(COALESCE(m.worker_name, '')), '') AS worker_name,
          NULLIF(TRIM(COALESCE(m.nome, '')), '') AS nome,
          NULLIF(TRIM(COALESCE(m.modelo, '')), '') AS modelo
        FROM miners m
      ),
      prev_event_state AS (
        SELECT DISTINCT ON (e.miner_id)
          e.miner_id,
          UPPER(e.to_state) AS state
        FROM miner_state_events e
        JOIN month_bounds b ON true
        WHERE e.occurred_at_utc < b.month_start
        ORDER BY e.miner_id, e.occurred_at_utc DESC, e.id DESC
      ),
      prev_stable_state AS (
        SELECT
          s.miner_id,
          UPPER(s.current_state) AS state
        FROM miner_state s
        JOIN month_bounds b ON true
        WHERE s.stable_since_utc <= b.month_start
      ),
      initial_points AS (
        SELECT
          ms.miner_id,
          b.month_start AS ts,
          COALESCE(pe.state, ps.state, 'ONLINE') AS state
        FROM miners_scope ms
        JOIN month_bounds b ON true
        LEFT JOIN prev_event_state pe ON pe.miner_id = ms.miner_id
        LEFT JOIN prev_stable_state ps ON ps.miner_id = ms.miner_id
      ),
      event_points AS (
        SELECT
          e.miner_id,
          e.occurred_at_utc AS ts,
          UPPER(e.to_state) AS state
        FROM miner_state_events e
        JOIN month_bounds b ON true
        WHERE e.occurred_at_utc >= b.month_start
          AND e.occurred_at_utc < b.month_end
      ),
      timeline_points AS (
        SELECT miner_id, ts, state FROM initial_points
        UNION ALL
        SELECT miner_id, ts, state FROM event_points
      ),
      ranked_points AS (
        SELECT
          p.miner_id,
          p.ts,
          p.state,
          LEAD(p.ts) OVER (PARTITION BY p.miner_id ORDER BY p.ts ASC) AS next_ts
        FROM timeline_points p
      ),
      segments AS (
        SELECT
          rp.miner_id,
          rp.state,
          rp.ts AS started_at,
          COALESCE(rp.next_ts, b.month_end) AS ended_at
        FROM ranked_points rp
        JOIN month_bounds b ON true
        WHERE COALESCE(rp.next_ts, b.month_end) > rp.ts
      )
      SELECT
        ms.user_id,
        ms.miner_id,
        COALESCE(ms.worker_name, CONCAT_WS(' ', ms.nome, ms.modelo), CONCAT('Miner #', ms.miner_id::text)) AS worker_name,
        COUNT(*) FILTER (WHERE s.state = 'OFFLINE')::int AS offline_intervals,
        COALESCE(
          SUM(
            CASE
              WHEN s.state = 'OFFLINE'
                THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))
              ELSE 0
            END
          ),
          0
        )::double precision AS offline_seconds
      FROM miners_scope ms
      LEFT JOIN segments s ON s.miner_id = ms.miner_id
      GROUP BY ms.user_id, ms.miner_id, worker_name
      HAVING COALESCE(
        SUM(
          CASE
            WHEN s.state = 'OFFLINE'
              THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))
            ELSE 0
          END
        ),
        0
      ) > 0
      ORDER BY offline_seconds DESC, ms.miner_id ASC
    `;

    const byUser = new Map();
    for (const r of perMiner || []) {
      const userId = String(r.user_id || "");
      if (!userId) continue;
      const offlineSeconds = Number(r.offline_seconds || 0);
      const offlineHours = offlineSeconds / 3600;
      const miner = {
        miner_id: Number(r.miner_id),
        worker_name: r.worker_name || `Miner #${String(r.miner_id)}`,
        offline_hours: Number(offlineHours.toFixed(2)),
        offline_intervals: Number(r.offline_intervals || 0),
      };
      if (!byUser.has(userId)) {
        byUser.set(userId, {
          user_id: userId,
          name: null,
          email: null,
          offline_hours: 0,
          offline_miners: 0,
          miners: [],
        });
      }
      const bucket = byUser.get(userId);
      bucket.miners.push(miner);
      bucket.offline_hours += miner.offline_hours;
      bucket.offline_miners += 1;
    }

    const users = Array.from(byUser.values())
      .map((u) => ({
        ...u,
        offline_hours: Number(u.offline_hours.toFixed(2)),
        miners: u.miners.sort((a, b) => b.offline_hours - a.offline_hours),
      }))
      .sort((a, b) => b.offline_hours - a.offline_hours);

    await Promise.allSettled(
      users.map(async (u) => {
        try {
          const clerkUser = await getClerkUserById(u.user_id);
          const profile = userDisplayFromClerk(clerkUser);
          u.name = profile.name;
          u.email = profile.email;
        } catch {
          // Keep user_id as fallback when Clerk lookup fails.
        }
      })
    );

    const totalOfflineHours = users.reduce((acc, u) => acc + Number(u.offline_hours || 0), 0);
    const totalOfflineMiners = users.reduce((acc, u) => acc + Number(u.offline_miners || 0), 0);

    return res.json({
      period: {
        year,
        month,
        start_utc: startUtc.toISOString(),
        end_utc: endUtc.toISOString(),
      },
      totals: {
        users: users.length,
        miners: totalOfflineMiners,
        offline_hours: Number(totalOfflineHours.toFixed(2)),
      },
      users,
    });
  } catch (err) {
    console.error("staff.offlineSummaryByMonth:", err);
    return res.status(500).json({ error: "failed_offline_summary" });
  }
}
