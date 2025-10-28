// src/routes/payments.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";
import { sql } from "../config/db.js";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import QRCode from "qrcode"; // ⚠️ npm i qrcode

const router = express.Router();

const NOW_API_KEY    = process.env.NOWPAYMENTS_API_KEY;
const NOW_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NOW_IPN_URL    = process.env.NOWPAYMENTS_WEBHOOK_URL;
const NOW_API        = "https://api.nowpayments.io/v1";

const SUPPORTED_CURRENCIES = ["USDC", "BTC", "LTC"];
const USDC_NETWORKS = ["ERC20", "BEP20"];
const CURR_TTL_MS = 15 * 60 * 1000;
let _currCache = { list: null, ts: 0 };

/* -------------------- DB helpers -------------------- */
async function invoiceById(trx, id) {
  const [row] = await trx/*sql*/`
    SELECT id, user_id, subtotal_amount, status,
           provider_payment_id, provider_currency, pay_network, pay_address, pay_amount, pay_url
    FROM energy_invoices
    WHERE id = ${id}
    LIMIT 1
  `;
  return row || null;
}
async function assertInvoiceOwnershipOrAdmin(trx, invoiceId, userId, isAdmin = false) {
  const inv = await invoiceById(trx, invoiceId);
  if (!inv) return { inv: null, allowed: false };
  if (isAdmin) return { inv, allowed: true };
  return { inv, allowed: String(inv.user_id) === String(userId) };
}

/* -------------------- Colunas opcionais -------------------- */
const EXTRA_COLS = {
  provider_status: false,
  provider_paid_amount: false,
  provider_txid: false,
  provider_confirmations: false,
  paid_at: false,
};
(async () => {
  try {
    const cols = await sql/*sql*/`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'energy_invoices'
    `;
    const names = new Set(cols.map(c => c.column_name));
    for (const k of Object.keys(EXTRA_COLS)) EXTRA_COLS[k] = names.has(k);
  } catch {}
})();

/* -------------------- NOWPayments helpers -------------------- */
async function getNowCurrenciesCached() {
  const now = Date.now();
  if (_currCache.list && now - _currCache.ts < CURR_TTL_MS) return _currCache.list;
  const r = await fetch(`${NOW_API}/currencies`, { headers: { "x-api-key": NOW_API_KEY } });
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (!r.ok) throw new Error(`NOWPayments /currencies HTTP ${r.status}`);
  let list = Array.isArray(data) ? data : (data.currencies || data.supported_currencies || []);
  _currCache = { list: list.map(s => String(s).toUpperCase()), ts: now };
  return _currCache.list;
}
async function mapPayCurrency(currency, network) {
  const c = String(currency).toUpperCase();
  const n = String(network || "").toUpperCase();
  const list = await getNowCurrenciesCached();
  if (c === "USDC") {
    if (!USDC_NETWORKS.includes(n)) throw new Error("Rede inválida");
    if (n === "ERC20" && list.includes("USDC")) return "USDC";
    if (n === "BEP20" && list.includes("USDCBSC")) return "USDCBSC";
  }
  if (c === "BTC" && list.includes("BTC")) return "BTC";
  if (c === "LTC" && list.includes("LTC")) return "LTC";
  throw new Error("Moeda não suportada");
}
const normalizeProviderStatus = s => String(s || "").toLowerCase();
const getAuthContext = req => ({
  userId: req.auth?.userId || null,
  isAdmin: !!req.auth?.sessionClaims?.public_metadata?.role?.toLowerCase?.()?.includes("admin"),
});

/* -------------------- /create-intent -------------------- */
router.post("/payments/create-intent", clerkMiddleware(), requireAuth(), async (req, res) => {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const { invoiceId, currency, network } = req.body || {};
    if (!invoiceId || !currency) return res.status(400).json({ error: "invoiceId e currency são obrigatórios" });

    const cur = String(currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(cur)) return res.status(400).json({ error: "Moeda inválida" });

    let net = String(network || "").toUpperCase();
    if (cur === "USDC" && !USDC_NETWORKS.includes(net)) return res.status(400).json({ error: "Rede inválida para USDC" });
    if (cur !== "USDC") net = "NATIVE";

    let sent = false;

    await sql.begin(async trx => {
      const { inv, allowed } = await assertInvoiceOwnershipOrAdmin(trx, invoiceId, userId, isAdmin);
      if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
      if (!allowed) return res.status(403).json({ error: "forbidden" });
      if (inv.status === "pago") return res.status(409).json({ error: "Fatura já paga" });

      if (inv.provider_payment_id && inv.status === "aguarda_pagamento") {
        sent = true;
        return res.json({
          ok: true,
          intent: {
            invoice_id: inv.id,
            currency: inv.provider_currency || cur,
            network: inv.pay_network || net,
            amount_fiat: inv.subtotal_amount,
            amount_crypto: inv.pay_amount,
            payment_address: inv.pay_address,
            pay_url: inv.pay_url,
            status: inv.status,
          },
        });
      }

      const pay_currency = await mapPayCurrency(cur, net);
      const price_amount = Number(inv.subtotal_amount);

      const payload = {
        price_amount,
        price_currency: "USD",
        pay_currency,
        order_id: `invoice_${invoiceId}`,
        order_description: `Energia #${invoiceId}`,
        ...(NOW_IPN_URL ? { ipn_callback_url: NOW_IPN_URL } : {}),
      };

      const npRes = await fetch(`${NOW_API}/payment`, {
        method: "POST",
        headers: { "x-api-key": NOW_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await npRes.text();
      let np; try { np = JSON.parse(raw); } catch { np = raw; }
      if (!npRes.ok || !np?.payment_id) return res.status(502).json({ error: "Erro PSP" });

      await trx/*sql*/`
        UPDATE energy_invoices
        SET status='aguarda_pagamento',
            provider_payment_id=${Number(np.payment_id)},
            provider_currency=${pay_currency},
            pay_network=${net},
            pay_address=${np.pay_address || null},
            pay_amount=${np.pay_amount || null},
            pay_url=${np.invoice_url || null},
            updated_at=NOW()
        WHERE id=${invoiceId}
      `;
      if (EXTRA_COLS.provider_status) {
        await trx/*sql*/`UPDATE energy_invoices SET provider_status=${normalizeProviderStatus(np.payment_status)} WHERE id=${invoiceId}`;
      }

      sent = true;
      return res.json({
        ok: true,
        intent: {
          invoice_id: invoiceId,
          currency: cur,
          network: net,
          provider_currency: pay_currency,
          amount_fiat: price_amount,
          amount_crypto: np.pay_amount || null,
          payment_address: np.pay_address || null,
          pay_url: np.invoice_url || null,
          status: "pending",
        },
      });
    });

    if (!sent) return res.status(500).json({ error: "Falha interna" });
  } catch (err) {
    console.error("create-intent:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

/* -------------------- /intent -------------------- */
router.get("/payments/intent", clerkMiddleware(), requireAuth(), async (req, res) => {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });
    const { inv, allowed } = await sql.begin(async trx => await assertInvoiceOwnershipOrAdmin(trx, invoiceId, userId, isAdmin));
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    return res.json({
      ok: true,
      intent: {
        invoice_id: inv.id,
        status: inv.status,
        provider_payment_id: inv.provider_payment_id,
        provider_currency: inv.provider_currency,
        network: inv.pay_network,
        payment_address: inv.pay_address,
        amount_crypto: inv.pay_amount,
        amount_fiat: inv.subtotal_amount,
        pay_url: inv.pay_url,
      },
    });
  } catch (e) {
    console.error("intent:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* -------------------- /sync -------------------- */
async function syncHandler(req, res) {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const invoiceId = Number(req.method === "GET" ? req.query.invoiceId : req.body?.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const { inv, allowed } = await sql.begin(async trx => await assertInvoiceOwnershipOrAdmin(trx, invoiceId, userId, isAdmin));
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!allowed) return res.status(403).json({ error: "forbidden" });

    if (!inv.provider_payment_id) return res.status(400).json({ error: "sem provider_payment_id" });

    const r = await fetch(`${NOW_API}/payment/${inv.provider_payment_id}`, {
      headers: { "x-api-key": NOW_API_KEY },
    });
    const p = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Erro PSP" });

    const status = normalizeProviderStatus(p.payment_status);
    await sql.begin(async trx => {
      if (status === "finished")
        await trx/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      else if (status === "partially_paid")
        await trx/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
      else if (["failed","expired"].includes(status))
        await trx/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;
      if (EXTRA_COLS.provider_status)
        await trx/*sql*/`UPDATE energy_invoices SET provider_status=${status} WHERE id=${invoiceId}`;
    });

    return res.json({ ok: true, provider_status: status });
  } catch (err) {
    console.error("sync:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
router.post("/payments/sync", clerkMiddleware(), requireAuth(), express.json(), syncHandler);
router.get("/payments/sync", clerkMiddleware(), requireAuth(), syncHandler);

/* -------------------- /webhook -------------------- */
router.post("/payments/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["x-nowpayments-sig"];
    if (NOW_IPN_SECRET) {
      const hmac = crypto.createHmac("sha512", NOW_IPN_SECRET).update(req.body).digest("hex");
      if (hmac.toLowerCase() !== String(sig || "").toLowerCase())
        return res.status(401).json({ error: "assinatura inválida" });
    }
    const p = JSON.parse(req.body.toString("utf8"));
    const paymentStatus = normalizeProviderStatus(p.payment_status);
    const orderId = String(p.order_id || "");
    const invoiceId = orderId.startsWith("invoice_") ? Number(orderId.replace("invoice_", "")) : null;
    if (!invoiceId) return res.json({ ok: true });
    await sql.begin(async trx => {
      await trx/*sql*/`UPDATE energy_invoices SET provider_status=${paymentStatus} WHERE id=${invoiceId}`;
      if (paymentStatus === "finished")
        await trx/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      else if (paymentStatus === "partially_paid")
        await trx/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
      else if (["failed","expired"].includes(paymentStatus))
        await trx/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("webhook:", e);
    return res.status(500).json({ error: "Erro webhook" });
  }
});

/* -------------------- /qr -------------------- */
/**
 * GET /api/payments/qr?address=...&amount=...&currency=BTC
 * devolve imagem base64 (png)
 */
router.get("/payments/qr", async (req, res) => {
  try {
    const { address, amount, currency } = req.query;
    if (!address || !currency)
      return res.status(400).json({ error: "address e currency são obrigatórios" });

    const c = String(currency).toUpperCase();
    let uri = "";
    if (c === "BTC") uri = `bitcoin:${address}?amount=${amount}`;
    else if (c === "LTC") uri = `litecoin:${address}?amount=${amount}`;
    else if (c === "USDC") uri = `${address}`; // só o endereço
    else uri = address;

    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 300 });
    return res.json({ ok: true, qr });
  } catch (err) {
    console.error("qr:", err);
    res.status(500).json({ error: "Erro ao gerar QR" });
  }
});

export default router;
