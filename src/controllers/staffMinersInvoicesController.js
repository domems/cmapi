// src/controllers/staffMinersInvoicesController.js
import express from "express";
import { sql } from "../config/db.js";
import { setCachedList, invalidateUserList } from "../services/minersListCache.js";

/* ===================== Utils ===================== */
const TAG = "[STAFF-MINERS+INVOICES]";
function log(...a)   { try { console.log(TAG, ...a); } catch {} }
function warn(...a)  { try { console.warn(TAG, ...a); } catch {} }
function error(...a) { try { console.error(TAG, ...a); } catch {} }

function parseIntIdOr400Param(req, res, key = "id") {
  const raw = req.params?.[key];
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    res.status(400).json({ error: `Parâmetro ${key} inválido (tem de ser inteiro).` });
    return null;
  }
  return num;
}
function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}
function normalizeDecimal(input) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Valor numérico inválido: "${input}"`);
    return input;
  }
  const s0 = String(input).trim().replace(/\s+/g, "");
  let s = s0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    const decSep = lastComma > lastDot ? "," : ".";
    const thouSep = decSep === "," ? /\./g : /,/g;
    s = s.replace(thouSep, "").replace(decSep, ".");
  } else if (hasComma) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: "${input}"`);
  return n;
}

const ALLOWED_STATUS = new Set(["online", "offline", "maintenance"]);
const ALLOWED_POOLS  = new Set(["ViaBTC", "LiteCoinPool"]);

function ensureStatus(val) {
  if (val === undefined || val === null || val === "") return null;
  const v = String(val).toLowerCase();
  if (!ALLOWED_STATUS.has(v)) throw new Error("Status inválido (use 'online'|'offline'|'maintenance').");
  return v;
}
function canonicalPool(val) {
  if (val === undefined || val === null || val === "") return null;
  const v = String(val).trim();
  if (/^viabtc$/i.test(v)) return "ViaBTC";
  if (/^lite\s*coin\s*pool$/i.test(v) || /^litecoinpool$/i.test(v)) return "LiteCoinPool";
  if (!ALLOWED_POOLS.has(v)) throw new Error("Pool inválida (use 'ViaBTC' ou 'LiteCoinPool').");
  return v;
}
function redactSecrets(row, allowSecrets) {
  if (allowSecrets) return row;
  const { api_key, secret_key, ...rest } = row || {};
  return { ...rest, api_key: null, secret_key: null };
}

function getRoleLoose(req) {
  return String(
    req.auth?.sessionClaims?.metadata?.role ||
    req.auth?.claims?.metadata?.role ||
    req.user?.publicMetadata?.role ||
    req.headers["x-user-role"] ||
    req.headers["x-role"] ||
    ""
  ).toLowerCase();
}
function allowReveal(req) {
  // Rotas já protegidas a montante, mas isto evita leaks caso alguém mexa no server.js
  const role = getRoleLoose(req);
  return role === "staff" || role === "admin";
}

/* ===================== Router ===================== */
const router = express.Router();

/* ---------- MINERS (por utilizador alvo) ---------- */

/**
 * GET /api/staff/users/:userId/miners
 * Query: ?reveal=1 (apenas staff/admin)
 * Paginação opcional: ?limit=&offset=
 */
router.get("/users/:userId/miners", async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  const revealFlag = String(req.query.reveal || "") === "1";
  const reveal = revealFlag && allowReveal(req); // endurecido, sem partir o frontend
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 0)) || null; // opcional
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const rows = await sql/*sql*/`
      SELECT
        id, user_id, nome, modelo, hash_rate,
        preco_kw, consumo_kw_hora,
        COALESCE(status,'offline') AS status,
        worker_name, api_key, secret_key, coin, pool,
        locked, total_horas_online, created_at, updated_at
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
      ${limit ? sql`LIMIT ${limit} OFFSET ${offset}` : sql``}
    `;
    const safe = rows.map(r => redactSecrets(r, reveal));

    const { etag } = setCachedList(`u:${userId}:reveal:${reveal ? 1 : 0}:limit:${limit||"all"}:offset:${offset}`, safe);
    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) return res.status(304).end();

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=60");
    res.setHeader("Vary", "Authorization, Accept, Accept-Encoding");
    res.json(safe);
  } catch (e) {
    error("GET /users/:userId/miners", e?.message || e);
    res.status(500).json({ error: "Erro ao listar miners" });
  }
});

/**
 * POST /api/staff/users/:userId/miners
 * Cria **um** miner.
 */
router.post("/users/:userId/miners", async (req, res) => {
  const user_id = String(req.params.userId || "");
  if (!user_id) return res.status(400).json({ error: "userId em falta" });

  const {
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora,
    status,
    worker_name,
    api_key,
    secret_key,
    coin,
    pool,
    locked,
  } = req.body || {};

  try {
    const nomeClean = String(nome || "").trim();
    if (!nomeClean) return res.status(400).json({ error: "Campo obrigatório em falta: nome." });

    let hashRateNum = null, precoKwNum = null, consumoNum = null, poolVal = null, statusVal = null;
    try {
      hashRateNum = normalizeDecimal(hash_rate);
      precoKwNum  = normalizeDecimal(preco_kw);
      consumoNum  = normalizeDecimal(consumo_kw_hora);
      statusVal   = ensureStatus(status) ?? "offline";
      poolVal     = canonicalPool(pool);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const lockedVal = typeof locked === "boolean" ? locked : true;

    const [row] = await sql/*sql*/`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status,
        worker_name, api_key, secret_key, coin, pool, locked
      ) VALUES (
        ${user_id},
        ${nomeClean},
        ${modelo ? String(modelo).trim() : null},
        ${hashRateNum},
        ${precoKwNum},
        ${consumoNum},
        ${statusVal},
        ${worker_name ? String(worker_name).trim() : null},
        ${api_key ? String(api_key).trim() : null},
        ${secret_key ? String(secret_key).trim() : null},
        ${coin ? String(coin).trim() : null},
        ${poolVal},
        ${lockedVal}
      )
      RETURNING *
    `;
    invalidateUserList(user_id); // deve invalidar todos os variants
    res.status(201).json(row);
  } catch (e) {
    error("POST /users/:userId/miners", e?.message || e);
    res.status(500).json({ error: "Erro ao criar miner" });
  }
});

/**
 * POST /api/staff/users/:userId/miners/bulk
 * Cria **N** miners. Padrões com {n}.
 */
router.post("/users/:userId/miners/bulk", async (req, res) => {
  const user_id = String(req.params.userId || "");
  if (!user_id) return res.status(400).json({ error: "userId em falta" });

  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: "count inválido (1..200)" });
  }

  const values = req.body?.values || {};
  const patterns = req.body?.patterns || {};

  try {
    const nomeBase       = values?.nome ? String(values.nome).trim() : null;
    const modeloBase     = values?.modelo ? String(values.modelo).trim() : null;
    const hashRateNum    = normalizeDecimal(values?.hash_rate);
    const precoKwNum     = normalizeDecimal(values?.preco_kw);
    const consumoNum     = normalizeDecimal(values?.consumo_kw_hora);
    const statusVal      = ensureStatus(values?.status) ?? "offline";
    const workerBase     = values?.worker_name ? String(values.worker_name).trim() : null;
    const apiKeyBase     = values?.api_key ? String(values.api_key).trim() : null;
    const secretKeyBase  = values?.secret_key ? String(values.secret_key).trim() : null;
    const coinBase       = values?.coin ? String(values.coin).trim() : null;
    const poolVal        = canonicalPool(values?.pool);
    const lockedVal      = typeof values?.locked === "boolean" ? values.locked : true;

    const nomePattern   = patterns?.nomePattern ? String(patterns.nomePattern) : null;
    const workerPattern = patterns?.workerNamePattern ? String(patterns.workerNamePattern) : null;

    const inserted = await sql/*sql*/`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status,
        worker_name, api_key, secret_key, coin, pool, locked
      )
      SELECT
        ${user_id} AS user_id,
        CASE
          WHEN ${nomePattern}::text IS NOT NULL THEN REPLACE(${nomePattern}::text, '{n}', gs.n::text)
          ELSE ${nomeBase}::text
        END AS nome,
        ${modeloBase}::text AS modelo,
        ${hashRateNum}::numeric AS hash_rate,
        ${precoKwNum}::numeric AS preco_kw,
        ${consumoNum}::numeric AS consumo_kw_hora,
        ${statusVal}::text AS status,
        CASE
          WHEN ${workerPattern}::text IS NOT NULL THEN REPLACE(${workerPattern}::text, '{n}', gs.n::text)
          ELSE ${workerBase}::text
        END AS worker_name,
        ${apiKeyBase}::text AS api_key,
        ${secretKeyBase}::text AS secret_key,
        ${coinBase}::text AS coin,
        ${poolVal}::text AS pool,
        ${lockedVal}::boolean AS locked
      FROM generate_series(1, ${count}) AS gs(n)
      RETURNING id
    `;

    invalidateUserList(user_id);
    res.status(201).json({ ok: true, inserted: inserted.length });
  } catch (e) {
    error("POST /users/:userId/miners/bulk", e?.message || e);
    res.status(500).json({ error: "Erro ao criar miners em massa" });
  }
});

/**
 * PATCH /api/staff/miners/:id
 * — invalida cache do user antigo e do novo se moveres a máquina
 */
router.patch("/miners/:id", async (req, res) => {
  const id = parseIntIdOr400Param(req, res, "id");
  if (id === null) return;

  const {
    user_id,
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora,
    status,
    worker_name,
    api_key,
    secret_key,
    coin,
    pool,
    locked,
    total_horas_online,
  } = req.body || {};

  try {
    const [before] = await sql/*sql*/`SELECT user_id FROM miners WHERE id = ${id} LIMIT 1`;
    if (!before) return res.status(404).json({ error: "Miner não encontrada." });

    let hashRateNum, precoKwNum, consumoNum, hoursNum, statusVal, poolVal;
    try {
      if (hash_rate !== undefined)        hashRateNum = normalizeDecimal(hash_rate);
      if (preco_kw !== undefined)         precoKwNum  = normalizeDecimal(preco_kw);
      if (consumo_kw_hora !== undefined)  consumoNum  = normalizeDecimal(consumo_kw_hora);
      if (total_horas_online !== undefined) hoursNum  = normalizeDecimal(total_horas_online);
      if (status !== undefined)           statusVal   = ensureStatus(status);
      if (pool !== undefined)             poolVal     = canonicalPool(pool);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const [updated] = await sql/*sql*/`
      UPDATE miners
      SET
        user_id            = COALESCE(${user_id ?? null}, user_id),
        nome               = COALESCE(${nome !== undefined ? String(nome).trim() : null}, nome),
        modelo             = COALESCE(${modelo !== undefined ? String(modelo).trim() : null}, modelo),
        hash_rate          = COALESCE(${hashRateNum ?? null}, hash_rate),
        preco_kw           = COALESCE(${precoKwNum ?? null}, preco_kw),
        consumo_kw_hora    = COALESCE(${consumoNum ?? null}, consumo_kw_hora),
        status             = COALESCE(${statusVal ?? null}, status),
        worker_name        = COALESCE(${worker_name ?? null}, worker_name),
        api_key            = COALESCE(${api_key ?? null}, api_key),
        secret_key         = COALESCE(${secret_key ?? null}, secret_key),
        coin               = COALESCE(${coin ?? null}, coin),
        pool               = COALESCE(${poolVal ?? null}, pool),
        locked             = COALESCE(${locked ?? null}, locked),
        total_horas_online = COALESCE(${hoursNum ?? null}, total_horas_online),
        updated_at         = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: "Miner não encontrada." });

    // invalida caches do user antigo e do novo (se alterado)
    const oldUser = String(before.user_id);
    const newUser = String(updated.user_id);
    invalidateUserList(oldUser);
    if (newUser !== oldUser) invalidateUserList(newUser);

    res.json(updated);
  } catch (e) {
    error("PATCH /miners/:id", e?.message || e);
    res.status(500).json({ error: "Erro ao atualizar miner" });
  }
});

/**
 * DELETE /api/staff/miners/:id
 */
router.delete("/miners/:id", async (req, res) => {
  const id = parseIntIdOr400Param(req, res, "id");
  if (id === null) return;
  try {
    const [curr] = await sql/*sql*/`SELECT user_id FROM miners WHERE id = ${id} LIMIT 1`;
    await sql/*sql*/`DELETE FROM miners WHERE id = ${id}`;
    if (curr?.user_id) invalidateUserList(String(curr.user_id));
    res.status(204).end();
  } catch (e) {
    error("DELETE /miners/:id", e?.message || e);
    res.status(500).json({ error: "Erro ao apagar miner" });
  }
});

/**
 * POST /api/staff/miners/:id/status
 * Body: { status: 'online'|'offline'|'maintenance' }
 */
router.post("/miners/:id/status", async (req, res) => {
  const id = parseIntIdOr400Param(req, res, "id");
  if (id === null) return;

  let clean;
  try {
    clean = ensureStatus(req.body?.status);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  try {
    const [updated] = await sql/*sql*/`
      UPDATE miners
      SET status = ${clean}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, user_id, status
    `;
    if (!updated) return res.status(404).json({ error: "Miner não encontrada." });
    if (updated?.user_id) invalidateUserList(String(updated.user_id));
    res.json(updated);
  } catch (e) {
    error("POST /miners/:id/status", e?.message || e);
    res.status(500).json({ error: "Erro ao atualizar status do miner" });
  }
});

/* ---------- INVOICES (por utilizador alvo) ---------- */

/**
 * GET /api/staff/users/:userId/invoices
 * ?includeCurrent=1 para inserir o “em_curso” no topo.
 */
router.get("/users/:userId/invoices", async (req, res) => {
  const userId = String(req.params.userId || "");
  const includeCurrent = String(req.query.includeCurrent || "") === "1";
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  try {
    const saved = await sql/*sql*/`
      SELECT id, year, month,
             COALESCE(subtotal_amount,0)   AS subtotal_amount,
             COALESCE(status,'pendente')   AS status,
             COALESCE(currency_code,'USD') AS currency_code,
             created_at
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
    `;
    const rows = saved.map(r => ({
      id: Number(r.id),
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: Number(r.subtotal_amount),
      status: String(r.status),
      currency_code: String(r.currency_code || "USD"),
      created_at: r.created_at,
    }));

    if (includeCurrent) {
      const { year, month } = currentYearMonth();
      const [currencyRow] = await sql/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;
      const preferredCurrency = String(currencyRow?.currency_code || "USD");

      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text)) AS miner_nome,
          COALESCE(total_horas_online,0)             AS hours_online,
          COALESCE(consumo_kw_hora,0)                AS consumo_kw_hora,
          COALESCE(preco_kw,0)                       AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY id ASC
      `;
      const items = miners.map(r => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);
        return { amount_eur: amount };
      });
      const subtotal = +items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0).toFixed(2);

      rows.unshift({
        id: undefined,
        year,
        month,
        subtotal_amount: subtotal,
        status: "em_curso",
        currency_code: preferredCurrency,
        created_at: null,
      });
    }

    res.json(rows);
  } catch (e) {
    error("GET /users/:userId/invoices", e?.message || e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/**
 * GET /api/staff/users/:userId/invoices/current/summary
 */
router.get("/users/:userId/invoices/current/summary", async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  try {
    const rows = await sql/*sql*/`
      SELECT
        COALESCE(SUM(total_horas_online),0) AS total_hours,
        COALESCE(SUM(total_horas_online * COALESCE(consumo_kw_hora,0)),0) AS total_kwh,
        COALESCE(SUM(
          ROUND(total_horas_online * COALESCE(consumo_kw_hora,0), 3) * COALESCE(preco_kw,0)
        ),0) AS subtotal_amount
      FROM miners
      WHERE user_id = ${userId}
    `;
    const r = rows[0] || {};
    res.json({
      total_hours: Number(r.total_hours || 0),
      total_kwh: Number(r.total_kwh || 0),
      subtotal_amount: Number(r.subtotal_amount || 0),
    });
  } catch (e) {
    error("GET /users/:userId/invoices/current/summary", e?.message || e);
    res.status(500).json({ error: "Erro ao calcular resumo atual" });
  }
});

/**
 * GET /api/staff/users/:userId/invoices/detail
 * - em curso:   ?current=1
 * - fechada:    ?invoiceId=123
 * - retro:      ?year=YYYY&month=M
 */
router.get("/users/:userId/invoices/detail", async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  const isCurrent = String(req.query.current || "") === "1";
  const invoiceId = req.query.invoiceId ? Number(req.query.invoiceId) : undefined;
  const year = req.query.year ? Number(req.query.year) : undefined;
  const month = req.query.month ? Number(req.query.month) : undefined;

  try {
    if (isCurrent) {
      const { year: y, month: m } = currentYearMonth();
      const [currencyRow] = await sql/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;
      const preferredCurrency = String(currencyRow?.currency_code || "USD");

      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
          COALESCE(worker_name, '')                    AS worker_name,
          COALESCE(modelo, '')                         AS modelo,
          COALESCE(hash_rate, '')                      AS hash_rate,
          COALESCE(total_horas_online,0)               AS hours_online,
          COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
          COALESCE(preco_kw,0)                         AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY
          CASE WHEN NULLIF(worker_name,'') IS NULL THEN 1 ELSE 0 END,
          LOWER(COALESCE(NULLIF(worker_name,''), nome, CONCAT('Miner#', id::text))),
          id ASC
      `;
      const items = miners.map(r => {
        const hours   = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco   = Number(r.preco_kw) || 0;
        const kwh     = +(hours * consumo).toFixed(3);
        const amount  = +(kwh * preco).toFixed(2);
        const worker  = String(r.worker_name || "").trim() || null;
        const modelo  = String(r.modelo || "").trim() || null;
        const hashRt  = String(r.hash_rate || "").trim() || null;
        return {
          miner_id: r.id,
          miner_nome: String(r.miner_nome),
          worker_name: worker,
          modelo,
          hash_rate: hashRt,
          hours_online: hours,
          kwh_used: kwh,
          consumo_kw_hora: consumo,
          preco_kw: preco,
          amount_eur: amount,
        };
      });
      const subtotal  = +items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0).toFixed(2);
      const total_kwh = +items.reduce((acc, it) => acc + Number(it.kwh_used  || 0), 0).toFixed(3);
      return res.json({
        header: {
          invoice_id: undefined,
          year: y,
          month: m,
          status: "em_curso",
          subtotal_amount: subtotal,
          currency_code: preferredCurrency,
          total_kwh,
        },
        items,
      });
    }

    // fechada/retro
    let invRow;
    if (invoiceId) {
      const rows = await sql/*sql*/`
        SELECT id, year, month,
               COALESCE(subtotal_amount,0) AS subtotal_amount,
               COALESCE(status,'pendente') AS status,
               COALESCE(currency_code,'USD') AS currency_code,
               created_at
        FROM energy_invoices
        WHERE user_id = ${userId} AND id = ${invoiceId}
        LIMIT 1
      `;
      invRow = rows[0];
      if (!invRow) return res.status(404).json({ error: "Fatura não encontrada" });
    } else {
      if (!year || !month) return res.status(400).json({ error: "year e month em falta" });
      const rows = await sql/*sql*/`
        SELECT id, year, month,
               COALESCE(subtotal_amount,0) AS subtotal_amount,
               COALESCE(status,'pendente') AS status,
               COALESCE(currency_code,'USD') AS currency_code,
               created_at
        FROM energy_invoices
        WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
      invRow = rows[0];
      if (!invRow) return res.status(404).json({ error: "Fatura não encontrada" });
    }

    const items = await sql/*sql*/`
      SELECT 
        eii.miner_id,
        eii.miner_nome,
        COALESCE(eii.hours_online,0)     AS hours_online,
        COALESCE(eii.kwh_used,0)         AS kwh_used,
        COALESCE(eii.preco_kw,0)         AS preco_kw,
        COALESCE(eii.consumo_kw_hora,0)  AS consumo_kw_hora,
        COALESCE(eii.amount_eur,0)       AS amount_eur,
        COALESCE(m.worker_name, '')      AS worker_name,
        COALESCE(m.modelo, '')           AS modelo,
        COALESCE(m.hash_rate, '')        AS hash_rate
      FROM energy_invoice_items eii
      LEFT JOIN miners m ON m.id = eii.miner_id
      WHERE eii.invoice_id = ${invRow.id}
      ORDER BY
        CASE WHEN NULLIF(m.worker_name,'') IS NULL THEN 1 ELSE 0 END,
        LOWER(COALESCE(NULLIF(m.worker_name,''), eii.miner_nome)),
        eii.miner_id ASC
    `;
    const total_kwh = +items.reduce((acc, it) => acc + Number(it.kwh_used || 0), 0).toFixed(3);

    return res.json({
      header: {
        invoice_id: Number(invRow.id),
        year: Number(invRow.year),
        month: Number(invRow.month),
        status: String(invRow.status),
        subtotal_amount: Number(invRow.subtotal_amount),
        currency_code: String(invRow.currency_code || "USD"),
        total_kwh,
        created_at: invRow.created_at,
      },
      items: items.map(r => ({
        miner_id: r.miner_id,
        miner_nome: String(r.miner_nome),
        worker_name: (String(r.worker_name || "").trim() || null),
        modelo: (String(r.modelo || "").trim() || null),
        hash_rate: (String(r.hash_rate || "").trim() || null),
        hours_online: Number(r.hours_online),
        kwh_used: Number(r.kwh_used),
        consumo_kw_hora: Number(r.consumo_kw_hora),
        preco_kw: Number(r.preco_kw),
        amount_eur: Number(r.amount_eur),
      })),
    });
  } catch (e) {
    error("GET /users/:userId/invoices/detail", e?.message || e);
    res.status(500).json({ error: "Erro ao obter fatura" });
  }
});

/**
 * POST /api/staff/users/:userId/invoices/close-now
 * Fecha a fatura “em curso” do user (mínimo 15 USD).
 * — transação + advisory lock para evitar duplicados em race
 */
router.post("/users/:userId/invoices/close-now", async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  const { year, month } = currentYearMonth();

  try {
    const result = await sql.begin(async (tx) => {
      // lock por user/mês (estável, sem schema extra)
      const hashKey = Math.abs(
        BigInt(
          (String(userId) + ":" + year + ":" + month)
            .split("")
            .reduce((a, c) => ((a * 131) ^ c.charCodeAt(0)) >>> 0, 0)
        )
      );
      await tx/*sql*/`SELECT pg_advisory_xact_lock(${hashKey})`;

      // moeda preferida coerente com includeCurrent
      const [currencyRow] = await tx/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;
      const preferredCurrency = String(currencyRow?.currency_code || "USD");

      // já existe?
      const [existing] = await tx/*sql*/`
        SELECT id FROM energy_invoices
        WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
        LIMIT 1
      `;
      if (existing) {
        return { already: true, invoiceId: Number(existing.id), currency: preferredCurrency };
      }

      // calcula subtotal (tudo em SQL/NUMERIC seria o ideal; aqui somamos em app mas arredondamos igual)
      const miners = await tx/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text)) AS miner_nome,
          COALESCE(total_horas_online,0)             AS hours_online,
          COALESCE(consumo_kw_hora,0)                AS consumo_kw_hora,
          COALESCE(preco_kw,0)                       AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
      `;
      const subtotalCalc = miners.reduce((acc, r) => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);
        return acc + amount;
      }, 0);
      const subtotalRoundedCheck = Math.round(subtotalCalc * 100) / 100;

      const MIN_TOTAL = 15; // USD
      if (subtotalRoundedCheck < MIN_TOTAL) {
        return { tooLow: true, min: MIN_TOTAL, current: subtotalRoundedCheck };
      }

      const insertedInv = await tx/*sql*/`
        INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
        VALUES (${userId}, ${year}, ${month}, 0, 'pendente', ${preferredCurrency})
        RETURNING id, created_at
      `;
      const invoiceId = Number(insertedInv[0].id);

      const insertedItems = await tx/*sql*/`
        INSERT INTO energy_invoice_items
          (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
        SELECT
          ${invoiceId},
          m.id,
          COALESCE(m.nome, CONCAT('Miner#', m.id::text)) AS miner_nome,
          COALESCE(m.total_horas_online,0)               AS hours_online,
          ROUND(COALESCE(m.total_horas_online,0) * COALESCE(m.consumo_kw_hora,0), 3) AS kwh_used,
          COALESCE(m.preco_kw,0)                         AS preco_kw,
          COALESCE(m.consumo_kw_hora,0)                  AS consumo_kw_hora,
          ROUND(
            ROUND(COALESCE(m.total_horas_online,0) * COALESCE(m.consumo_kw_hora,0), 3) * COALESCE(m.preco_kw,0),
            2
          ) AS amount_eur
        FROM miners m
        WHERE m.user_id = ${userId}
        RETURNING amount_eur
      `;
      const itemsCount = insertedItems.length;
      const subtotal = insertedItems.reduce((acc, r) => acc + Number(r.amount_eur || 0), 0);
      const subtotalRounded = Math.round(subtotal * 100) / 100;

      await tx/*sql*/`
        UPDATE energy_invoices
        SET subtotal_amount = ${subtotalRounded}::numeric,
            updated_at = NOW(),
            status = 'pendente'
        WHERE id = ${invoiceId}
      `;
      await tx/*sql*/`UPDATE miners SET total_horas_online = 0 WHERE user_id = ${userId}`;

      return { ok: true, invoiceId, itemsCount, subtotalRounded, currency: preferredCurrency };
    });

    if (result?.already) {
      return res.json({
        ok: true,
        invoice: { id: result.invoiceId, year, month, status: "pendente" },
        note: "Fatura do mês já existe",
      });
    }
    if (result?.tooLow) {
      return res.status(400).json({
        error: "Fatura demasiado baixa para fechar",
        min_required: result.min,
        current_subtotal: result.current,
      });
    }

    invalidateUserList(userId);
    return res.json({
      ok: true,
      invoice: {
        id: result.invoiceId,
        year,
        month,
        status: "pendente",
        items_count: result.itemsCount,
        subtotal_amount: result.subtotalRounded,
        currency_code: result.currency,
      },
    });
  } catch (e) {
    error("POST /users/:userId/invoices/close-now", { code: e?.code, detail: e?.detail, message: e?.message });
    return res.status(500).json({ error: e?.detail || e?.message || "Erro ao fechar fatura" });
  }
});

/**
 * GET /api/staff/invoices/status?invoiceId=123
 */
router.get("/invoices/status", async (req, res) => {
  const invoiceId = Number(req.query.invoiceId);
  if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

  try {
    const [inv] = await sql/*sql*/`
      SELECT id, status, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    res.json({
      ok: true,
      invoice: { id: Number(inv.id), status: String(inv.status), subtotal_amount: Number(inv.subtotal_amount) },
    });
  } catch (e) {
    error("GET /invoices/status", e?.message || e);
    res.status(500).json({ error: "Erro ao consultar estado da fatura" });
  }
});

export default router;
