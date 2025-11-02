// src/controllers/staffController.js
import { sql } from "../config/db.js";

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

/* ---------- Health ---------- */
export async function ping(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
}

/* ---------- KPIs de Miners ---------- */
export async function statsMiners(_req, res) {
  try {
    const [row] = await sql/*sql*/`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN LOWER(COALESCE(status,'')) LIKE '%maint%' THEN 1
            WHEN LOWER(COALESCE(status,'')) IN ('online','active','up') THEN 1
            WHEN COALESCE(status,'') IN ('1','true','TRUE') THEN 1
            ELSE 0
          END
        ),0) AS online,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'')) LIKE '%maint%' THEN 1 ELSE 0 END),0) AS maintenance,
        COALESCE(COUNT(*),0) AS total
      FROM miners;
    `;
    const online = Number(row?.online || 0);
    const maintenance = Number(row?.maintenance || 0);
    const total = Number(row?.total || 0);
    const offline = Math.max(0, total - online - maintenance);
    res.json({ online, offline, maintenance, total });
  } catch (err) {
    console.error("staff.statsMiners:", err);
    res.status(500).json({ error: "failed_stats_miners" });
  }
}

/* ---------- Resumo global do mês corrente ---------- */
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

/* ---------- Lista global de faturas (+ opcional em_curso sintético) ---------- */
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

/* ---------- Contador global de notificações por ler ---------- */
export async function notificationsUnreadCount(_req, res) {
  try {
    const rows = await sql/*sql*/`
      SELECT COALESCE(COUNT(*),0) AS count
      FROM notifications
      WHERE read_at IS NULL;
    `;
    const count = Number(rows?.[0]?.count || 0);
    res.json({ count });
  } catch (err) {
    // Se não existir tabela/coluna, devolve 0 (não parte a UI)
    res.json({ count: 0 });
  }
}

/* ---------- Listagem de miners (global) com ETag ---------- */
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

    const items = await sql/*sql*/`
      SELECT *
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

/* ---------- Status helpers (leitura) ---------- */
export async function obterStatusBatch(req, res) {
  try {
    const raw = String(req.query.ids || "").trim();
    const ids = raw ? raw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.json([]);
    const MAX_IDS = 500;
    const idsCapped = ids.slice(0, MAX_IDS);
    const result = await sql.unsafe(
      `
      SELECT id, COALESCE(status, 'offline') AS status
      FROM miners
      WHERE id = ANY($1::int[])
      ORDER BY id ASC
      `,
      [idsCapped]
    );
    const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
    return res.json(rows.map((r) => ({ id: Number(r.id), status: String(r.status) })));
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
      SELECT id, COALESCE(status, 'offline') AS status
      FROM miners
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Miner não encontrada." });
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    console.error("staff.obterStatusPorId:", err);
    res.status(err?.status || 500).json({ error: err.message || "Erro ao obter status." });
  }
}
