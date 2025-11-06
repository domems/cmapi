// src/routes/invoicesRoutes.js
import express from "express";
import { sql } from "../config/db.js";

// Se usares clerkMiddleware no server.js, req.auth fica preenchido
// ex: app.use(clerkMiddleware())

const router = express.Router();

/* ===================== Utils ===================== */
const TAG = "[invoices]";
const log = (...a) => { try { console.log(TAG, ...a); } catch {} };
const warn = (...a) => { try { console.warn(TAG, ...a); } catch {} };
const error = (...a) => { try { console.error(TAG, ...a); } catch {} };

function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}
function boolFrom(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}
function pickUserId(req) {
  // prioridade: Clerk → headers → query/body (retrocompat)
  const a =
    req.auth?.userId ||
    req.auth?.sessionClaims?.sub ||
    req.headers["x-user-id"] ||
    req.query.userId ||
    req.body?.userId ||
    "";
  return String(a || "").trim();
}
function money2(v, dp = 2) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : 0;
}

/* ===================== GET /api/invoices =====================
 * Aceita:
 *   - userId (opcional; preferimos do JWT)
 *   - includeCurrent: 1 | true
 * Devolve:
 *   - lista de faturas fechadas ordenadas (mais recente primeiro)
 *   - e opcionalmente o snapshot "em_curso" no topo
 * ============================================================ */
router.get("/invoices", async (req, res) => {
  try {
    const userId = pickUserId(req);
    const includeCurrent = boolFrom(req.query.includeCurrent);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const saved = await sql/*sql*/`
      SELECT id, year, month,
             COALESCE(subtotal_amount,0) AS subtotal_amount,
             COALESCE(status,'pendente') AS status,
             COALESCE(currency_code,'USD') AS currency_code,
             created_at
      FROM energy_invoices
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
    `;

    const rows = saved.map((r) => ({
      id: Number(r.id),
      year: Number(r.year),
      month: Number(r.month),
      subtotal_amount: money2(r.subtotal_amount),
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

      const miners = await sql/*sql*/`
        SELECT
          id,
          COALESCE(nome, CONCAT('Miner#', id::text))   AS miner_nome,
          COALESCE(total_horas_online,0)               AS hours_online,
          COALESCE(consumo_kw_hora,0)                  AS consumo_kw_hora,
          COALESCE(preco_kw,0)                         AS preco_kw
        FROM miners
        WHERE user_id = ${userId}
        ORDER BY id ASC
      `;

      const items = miners.map((r) => {
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = money2(hours * consumo, 3);
        const amount = money2(kwh * preco, 2);
        return {
          miner_id: r.id,
          miner_nome: String(r.miner_nome),
          hours_online: hours,
          kwh_used: kwh,
          consumo_kw_hora: consumo,
          preco_kw: preco,
          amount_eur: amount,
        };
      });

      const subtotal = money2(items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0), 2);

      rows.unshift({
        id: undefined,
        year,
        month,
        subtotal_amount: subtotal,
        status: "em_curso",
        currency_code: String(currencyRow?.currency_code || "USD"),
        created_at: null,
      });
    }

    res.json(rows);
  } catch (e) {
    error("GET /invoices ERROR:", e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/* ===================== GET /api/invoices/detail =====================
 * Modos:
 *   - /api/invoices/detail?current=1|true
 *   - /api/invoices/detail?invoiceId=123
 *   - /api/invoices/detail?year=YYYY&month=M
 * Autorização: dono (via JWT/clerk) — sem userId → 401
 * Respostas:
 *   404 quando não encontra
 *   400 só em parâmetros inválidos
 * ================================================================ */
router.get("/invoices/detail", async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const isCurrent =
      boolFrom(req.query.current) ||
      String(req.query.current || "").trim() === "1"; // para tolerância extra

    const invoiceId = req.query.invoiceId ? Number(req.query.invoiceId) : undefined;
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;

    // ====== Snapshot "em_curso" ======
    if (isCurrent) {
      const { year: y, month: m } = currentYearMonth();

      const [currencyRow] = await sql/*sql*/`
        SELECT COALESCE(MAX(currency_code),'USD') AS currency_code
        FROM energy_invoices
        WHERE user_id = ${userId}
      `;

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

      const items = miners.map((r) => {
        const hours   = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco   = Number(r.preco_kw) || 0;
        const kwh     = money2(hours * consumo, 3);
        const amount  = money2(kwh * preco, 2);

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

      const subtotal  = money2(items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0), 2);
      const total_kwh = money2(items.reduce((acc, it) => acc + Number(it.kwh_used  || 0), 0), 3);

      return res.json({
        header: {
          invoice_id: undefined,
          year: y,
          month: m,
          status: "em_curso",
          subtotal_amount: subtotal,
          currency_code: String(currencyRow?.currency_code || "USD"),
          total_kwh,
        },
        items,
      });
    }

    // ====== Fechada (por id / ou por y,m) ======
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
      if (!Number.isInteger(year) || !Number.isInteger(month))
        return res.status(400).json({ error: "year e month em falta/invalidos" });

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

    const total_kwh = money2(items.reduce((acc, it) => acc + Number(it.kwh_used || 0), 0), 3);

    return res.json({
      header: {
        invoice_id: Number(invRow.id),
        year: Number(invRow.year),
        month: Number(invRow.month),
        status: String(invRow.status),
        subtotal_amount: money2(invRow.subtotal_amount, 2),
        currency_code: String(invRow.currency_code || "USD"),
        total_kwh,
        created_at: invRow.created_at,
      },
      items: items.map((r) => ({
        miner_id: r.miner_id,
        miner_nome: String(r.miner_nome),
        worker_name: (String(r.worker_name || "").trim() || null),
        modelo: (String(r.modelo || "").trim() || null),
        hash_rate: (String(r.hash_rate || "").trim() || null),
        hours_online: Number(r.hours_online),
        kwh_used: money2(r.kwh_used, 3),
        consumo_kw_hora: Number(r.consumo_kw_hora),
        preco_kw: Number(r.preco_kw),
        amount_eur: money2(r.amount_eur, 2),
      })),
    });
  } catch (e) {
    error("GET /invoices/detail ERROR:", e);
    res.status(500).json({ error: "Erro ao obter fatura" });
  }
});

/* ===================== POST /api/invoices/close-now =====================
 * Frontend manda corpo vazio. Aqui inferimos userId do JWT.
 * Mantém retrocompat se vier userId no body.
 * Regra mínima (15 USD) preservada.
 * ===================================================================== */
router.post("/invoices/close-now", async (req, res) => {
  const userId = pickUserId(req);
  const explicitUser = String(req.body?.userId || "").trim() || null;
  log("[POST] /invoices/close-now START", { userId, explicitUser, at: new Date().toISOString() });

  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { year, month } = currentYearMonth();

  try {
    // Snapshot atual dos miners
    const miners = await sql/*sql*/`
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
      const kwh = money2(hours * consumo, 3);
      const amount = money2(kwh * preco, 2);
      return acc + amount;
    }, 0);

    const subtotalRoundedCheck = money2(subtotalCalc, 2);

    const MIN_TOTAL = 15; // USD
    if (subtotalRoundedCheck < MIN_TOTAL) {
      log("[POST] /invoices/close-now BLOCKED: subtotal < min", {
        userId,
        subtotalRoundedCheck,
        min: MIN_TOTAL,
      });
      return res.status(400).json({
        error: "Fatura demasiado baixa para fechar",
        min_required: MIN_TOTAL,
        current_subtotal: subtotalRoundedCheck,
      });
    }

    // (Opcional) impedir duplicado do mesmo mês: se já existir pendente/aguarda_pagamento/pago desse mês, 409
    const [exists] = await sql/*sql*/`
      SELECT id FROM energy_invoices
      WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
      ORDER BY id DESC LIMIT 1
    `;
    if (exists?.id) {
      return res.status(409).json({ error: "Já existe fatura para este mês", invoice_id: Number(exists.id) });
    }

    // 1) cria fatura
    const insertedInv = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'USD')
      RETURNING id, created_at
    `;
    const invoiceId = Number(insertedInv[0].id);

    // 2) snapshot → items
    const insertedItems = await sql/*sql*/`
      INSERT INTO energy_invoice_items
        (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
      SELECT
        ${invoiceId},
        m.id,
        COALESCE(m.nome, CONCAT('Miner#', m.id::text)),
        COALESCE(m.total_horas_online,0),
        ROUND(COALESCE(m.total_horas_online,0) * COALESCE(m.consumo_kw_hora,0), 3),
        COALESCE(m.preco_kw,0),
        COALESCE(m.consumo_kw_hora,0),
        ROUND(ROUND(COALESCE(m.total_horas_online,0) * COALESCE(m.consumo_kw_hora,0), 3) * COALESCE(m.preco_kw,0), 2)
      FROM miners m
      WHERE m.user_id = ${userId}
      RETURNING amount_eur
    `;
    const itemsCount = insertedItems.length;
    const subtotal = insertedItems.reduce((acc, r) => acc + Number(r.amount_eur || 0), 0);
    const subtotalRounded = money2(subtotal, 2);

    // 3) update subtotal
    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${subtotalRounded}::numeric,
          updated_at = NOW(),
          status = 'pendente'
      WHERE id = ${invoiceId}
    `;

    // 4) reset horas
    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = 0
      WHERE user_id = ${userId}
    `;

    log("[POST] /invoices/close-now OK", { invoiceId, itemsCount, subtotal: subtotalRounded });

    return res.json({
      ok: true,
      invoice: {
        id: invoiceId,
        year,
        month,
        status: "pendente",
        items_count: itemsCount,
        subtotal_amount: subtotalRounded,
      },
    });
  } catch (e) {
    error("[POST] /invoices/close-now ERROR", { code: e?.code, detail: e?.detail, message: e?.message });
    return res.status(500).json({ error: e?.detail || e?.message || "Erro ao fechar fatura" });
  }
});

/* ===================== GET /api/invoices/status ===================== */
router.get("/invoices/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const [inv] = await sql/*sql*/`
      SELECT id, status, subtotal_amount
      FROM energy_invoices
      WHERE id = ${invoiceId}
      LIMIT 1
    `;
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    res.json({
      ok: true,
      invoice: {
        id: Number(inv.id),
        status: String(inv.status),
        subtotal_amount: money2(inv.subtotal_amount, 2),
      },
    });
  } catch (e) {
    error("GET /invoices/status ERROR:", e);
    res.status(500).json({ error: "Erro ao consultar estado da fatura" });
  }
});

export default router;
