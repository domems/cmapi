// src/controllers/staffMinersInvoicesController.js
import express from "express";
import { sql } from "../config/db.js";
import { setCachedList, invalidateUserList } from "../services/minersListCache.js";

/* ===================== Helpers ===================== */

function isStaffOrAdmin(req) {
  // Tenta várias fontes (Clerk middleware / proxies)
  const metaRole =
    req.auth?.sessionClaims?.metadata?.role ||
    req.auth?.claims?.metadata?.role ||
    req.user?.publicMetadata?.role ||
    req.headers["x-user-role"] ||
    req.headers["x-role"] ||
    "";

  const role = String(metaRole || "").toLowerCase();
  return role === "staff" || role === "admin";
}

function requireStaffOrAdmin(req, res) {
  if (!isStaffOrAdmin(req)) {
    res.status(403).json({ error: "Forbidden (staff/admin only)" });
    return false;
  }
  return true;
}

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

/* ===================== Router ===================== */

const router = express.Router();

/**
 * GET /api/staff/users/:userId/miners
 * Lista os miners do utilizador alvo (para staff/admin), com ETag e 304.
 */
router.get("/users/:userId/miners", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  try {
    const miners = await sql/*sql*/`
      SELECT
        id, user_id, nome, modelo, hash_rate,
        preco_kw, consumo_kw_hora,
        COALESCE(status,'offline') AS status,
        worker_name, api_key, secret_key, coin, pool,
        locked, created_at, updated_at
      FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC;
    `;

    const { etag } = setCachedList(userId, miners);
    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=60");
    res.setHeader("Vary", "Authorization, X-User-Email, X-User-Role, X-Role");
    res.json(miners);
  } catch (e) {
    console.error("[STAFF] GET /users/:userId/miners ERROR:", e);
    res.status(500).json({ error: "Erro ao listar miners" });
  }
});

/**
 * POST /api/staff/miners/:id/status
 * Body: { status: 'online'|'offline'|'maintenance' }
 */
router.post("/miners/:id/status", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

  const id = parseIntIdOr400Param(req, res, "id");
  if (id === null) return;

  const { status } = req.body || {};
  if (status !== undefined) {
    const clean = String(status).toLowerCase();
    if (!["online", "offline", "maintenance"].includes(clean)) {
      return res.status(400).json({ error: "Status inválido (use 'online'|'offline'|'maintenance')." });
    }
  }

  try {
    const [curr] = await sql/*sql*/`
      SELECT id, user_id FROM miners WHERE id = ${id} LIMIT 1
    `;
    if (!curr) return res.status(404).json({ error: "Miner não encontrada." });

    const [updated] = await sql/*sql*/`
      UPDATE miners
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;
    if (updated?.user_id) invalidateUserList(String(updated.user_id));

    res.json(updated);
  } catch (e) {
    console.error("[STAFF] POST /miners/:id/status ERROR:", e);
    res.status(500).json({ error: "Erro ao atualizar status do miner" });
  }
});

/**
 * GET /api/staff/users/:userId/invoices?includeCurrent=1
 * Lista faturas fechadas + (opcional) cartão “em curso”.
 */
router.get("/users/:userId/invoices", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

  const userId = String(req.params.userId || "");
  const includeCurrent = String(req.query.includeCurrent || "") === "1";
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  try {
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

      const subtotal = +items.reduce((acc, it) => acc + Number(it.amount_eur || 0), 0).toFixed(2);

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
    console.error("[STAFF] GET /users/:userId/invoices ERROR:", e);
    res.status(500).json({ error: "Erro ao listar faturas" });
  }
});

/**
 * GET /api/staff/users/:userId/invoices/detail
 *  - em curso:   ?current=1
 *  - por id:     ?invoiceId=123
 *  - por mês:    ?year=YYYY&month=M
 */
router.get("/users/:userId/invoices/detail", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

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
        const hours = Number(r.hours_online) || 0;
        const consumo = Number(r.consumo_kw_hora) || 0;
        const preco = Number(r.preco_kw) || 0;
        const kwh = +(hours * consumo).toFixed(3);
        const amount = +(kwh * preco).toFixed(2);

        const worker = String(r.worker_name || "").trim() || null;
        const modelo = String(r.modelo || "").trim() || null;
        const hashRt = String(r.hash_rate || "").trim() || null;

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
          currency_code: String(currencyRow?.currency_code || "USD"),
          total_kwh,
        },
        items,
      });
    }

    // fechada
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
    console.error("[STAFF] GET /users/:userId/invoices/detail ERROR:", e);
    res.status(500).json({ error: "Erro ao obter fatura" });
  }
});

/**
 * POST /api/staff/users/:userId/invoices/close-now
 * Fecha fatura “em curso” do user (aplica mínimo).
 */
router.post("/users/:userId/invoices/close-now", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "userId em falta" });

  const { year, month } = currentYearMonth();

  try {
    // subtotal atual a partir dos miners
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
      const kwh = +(hours * consumo).toFixed(3);
      const amount = +(kwh * preco).toFixed(2);
      return acc + amount;
    }, 0);

    const subtotalRoundedCheck = Math.round(subtotalCalc * 100) / 100;

    const MIN_TOTAL = 15; // USD
    if (subtotalRoundedCheck < MIN_TOTAL) {
      return res.status(400).json({
        error: "Fatura demasiado baixa para fechar",
        min_required: MIN_TOTAL,
        current_subtotal: subtotalRoundedCheck,
      });
    }

    // cria fatura
    const insertedInv = await sql/*sql*/`
      INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
      VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'USD')
      RETURNING id, created_at
    `;
    const invoiceId = Number(insertedInv[0].id);

    // snapshot -> items
    const insertedItems = await sql/*sql*/`
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

    // atualiza fatura
    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${subtotalRounded}::numeric,
          updated_at = NOW(),
          status = 'pendente'
      WHERE id = ${invoiceId}
    `;

    // reset horas
    await sql/*sql*/`
      UPDATE miners
      SET total_horas_online = 0
      WHERE user_id = ${userId}
    `;

    // invalida listas do user (miners e invoices consomem cache por user)
    invalidateUserList(userId);

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
    console.error("[STAFF] POST /users/:userId/invoices/close-now ERROR:", {
      code: e?.code, detail: e?.detail, message: e?.message,
    });
    return res.status(500).json({ error: e?.detail || e?.message || "Erro ao fechar fatura" });
  }
});

/**
 * GET /api/staff/invoices/status?invoiceId=123
 */
router.get("/invoices/status", async (req, res) => {
  if (!requireStaffOrAdmin(req, res)) return;

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
      invoice: {
        id: Number(inv.id),
        status: String(inv.status),
        subtotal_amount: Number(inv.subtotal_amount),
      },
    });
  } catch (e) {
    console.error("[STAFF] GET /invoices/status ERROR:", e);
    res.status(500).json({ error: "Erro ao consultar estado da fatura" });
  }
});

export default router;
