// src/routes/payments.js
import express from "express";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import crypto from "crypto";
import QRCode from "qrcode";
import { sql } from "../config/db.js";

/* ================== ENV & CONSTANTS ================== */
const NOW_API_KEY    = process.env.NOWPAYMENTS_API_KEY || "";
const NOW_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
const NOW_IPN_URL    = process.env.NOWPAYMENTS_WEBHOOK_URL || "";
const NOW_API        = "https://api.nowpayments.io/v1";

if (!NOW_API_KEY) console.error("[payments] NOWPAYMENTS_API_KEY missing — create-intent vai falhar.");

const SUPPORTED_CURRENCIES = ["USDC", "BTC", "LTC"];
const USDC_NETWORKS = ["ERC20", "BEP20"]; // ERC20 = Ethereum, BEP20 = BSC
const CURR_TTL_MS = 15 * 60 * 1000;
let _currCache = { list: null, ts: 0 };

/* ===== Dinheiro: SEM IEEE-754, SEM tretas ===== */
function money2Number(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const m = s.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!m) return Number(Number(v).toFixed(2));
  const int = m[1];
  const frac = (m[2] || "").padEnd(2, "0").slice(0, 2);
  return Number(`${int}.${frac}`);
}
function money2String(v) {
  return money2Number(v).toFixed(2);
}

/* ================== DB HELPERS ================== */
async function invoiceById(id) {
  const [row] = await sql/*sql*/`
    SELECT
      id,
      user_id,
      subtotal_amount,     -- valor a pagar
      status,
      provider_payment_id,
      provider_currency,
      pay_network,
      pay_address,
      pay_amount,
      pay_url
    FROM energy_invoices
    WHERE id = ${id}
    LIMIT 1
  `;
  return row || null;
}
function canAccess(inv, userId, isAdmin) {
  if (!inv) return false;
  if (isAdmin) return true;
  return String(inv.user_id) === String(userId);
}
async function txRun(fn) {
  await sql/*sql*/`BEGIN`;
  try {
    const r = await fn();
    await sql/*sql*/`COMMIT`;
    return r;
  } catch (e) {
    try { await sql/*sql*/`ROLLBACK`; } catch {}
    throw e;
  }
}

/* ================== OPTIONAL COLUMNS (best-effort) ================== */
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
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'energy_invoices'
    `;
    const names = new Set(cols.map(c => c.column_name));
    for (const k of Object.keys(EXTRA_COLS)) EXTRA_COLS[k] = names.has(k);
  } catch (e) {
    console.warn("[payments] optional columns detection failed:", e?.message || e);
  }
})();

/* ================== PSP HELPERS ================== */
async function getNowCurrenciesCached() {
  if (!NOW_API_KEY) throw new Error("PSP not configured: NOWPAYMENTS_API_KEY missing");
  const now = Date.now();
  if (_currCache.list && now - _currCache.ts < CURR_TTL_MS) return _currCache.list;
  const r = await fetch(`${NOW_API}/currencies`, { headers: { "x-api-key": NOW_API_KEY } });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) ? (data.message || data.error) : raw;
    throw new Error(`NOWPayments /currencies HTTP ${r.status}: ${msg}`);
  }
  const list = Array.isArray(data) ? data : (data.currencies || data.supported_currencies || []);
  _currCache = { list: list.map(s => String(s).toUpperCase()), ts: now };
  return _currCache.list;
}

async function mapPayCurrency(currency, network) {
  const c = String(currency).toUpperCase();
  const n = String(network || "").toUpperCase();
  const list = await getNowCurrenciesCached();

  if (c === "USDC") {
    if (!USDC_NETWORKS.includes(n)) throw new Error("Rede inválida para USDC");
    if (n === "ERC20") {
      if (!list.includes("USDC")) throw new Error("USDC(ERC20) indisponível no PSP");
      return "USDC";
    }
    if (n === "BEP20") {
      if (!list.includes("USDCBSC")) throw new Error("USDC(BEP20) indisponível no PSP");
      return "USDCBSC";
    }
  }
  if (c === "BTC") {
    if (!list.includes("BTC")) throw new Error("BTC indisponível no PSP");
    return "BTC";
  }
  if (c === "LTC") {
    if (!list.includes("LTC")) throw new Error("LTC indisponível no PSP");
    return "LTC";
  }
  throw new Error("Moeda não suportada");
}

const normalizeProviderStatus = s => String(s || "").toLowerCase();
const getAuthContext = (req) => {
  const role =
    req.auth?.sessionClaims?.public_metadata?.role ||
    req.auth?.sessionClaims?.metadata?.role ||
    req.user?.publicMetadata?.role ||
    "";
  const isAdmin = typeof role === "string" && role.toLowerCase().includes("admin");
  return { userId: req.auth?.userId || null, isAdmin: !!isAdmin };
};

/* =======================================================================
   COMO MONTAR NO SERVER (ordem importa!)
   -----------------------------------------------------------------------
   // ANTES do express.json: webhook cru (bodyParser.raw) + verificação HMAC
   app.post("/api/payments/nowpayments",
     bodyParser.raw({ type: "application/json", limit: "512kb" }),
     npLimiter,
     verifyNowPayments,
     (req,res,next)=>{ req.url="/payments/nowpayments"; next(); },
     paymentsWebhookRouter);

   // DEPOIS: app.use(express.json()); ... app.use("/api", paymentsRouter);
   ======================================================================= */

/* ===========================================================
   WEBHOOK ROUTER (raw body)
   =========================================================== */
export const webhookRouter = express.Router();

const npLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function verifyNowPayments(req, res, next) {
  try {
    const sigHeader = req.header("x-nowpayments-sig") || req.header("x-signature");
    if (!sigHeader) return res.status(400).send("Missing signature");
    if (!NOW_IPN_SECRET) return res.status(500).send("IPN secret not set");

    const payloadBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const hmac = crypto.createHmac("sha512", NOW_IPN_SECRET).update(payloadBuf).digest("hex");
    const a = Buffer.from(hmac.toLowerCase(), "utf8");
    const b = Buffer.from(String(sigHeader).toLowerCase(), "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send("Invalid signature");
    }

    let parsed;
    try {
      parsed = JSON.parse(payloadBuf.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }
    req.ipn = parsed;
    next();
  } catch (_e) {
    return res.status(400).send("Invalid webhook");
  }
}

/**
 * Caminho do webhook: /api/payments/nowpayments
 */
webhookRouter.post(
  "/payments/nowpayments",
  bodyParser.raw({ type: "application/json" }),
  npLimiter,
  verifyNowPayments,
  async (req, res) => {
    try {
      const evt = req.ipn;
      const externalId = String(evt?.payment_id || evt?.invoice_id || evt?.ipn_id || "").trim();
      if (!externalId) return res.status(400).send("Missing external id");

      // log bruto idempotente
      await sql/*sql*/`
        INSERT INTO payments_ipn (provider, external_id, payload)
        VALUES ('nowpayments', ${externalId}, ${sql.json(evt)})
        ON CONFLICT (external_id) DO NOTHING;
      `;

      // Reconciliação
      const orderId = String(evt?.order_id || "");
      const invoiceId = orderId.startsWith("invoice_") ? Number(orderId.replace("invoice_", "")) : null;
      if (!invoiceId) return res.status(200).send("ok");

      const paymentStatus = normalizeProviderStatus(evt.payment_status);
      if (EXTRA_COLS.provider_status)
        await sql/*sql*/`UPDATE energy_invoices SET provider_status=${paymentStatus} WHERE id=${invoiceId}`;
      if (paymentStatus === "finished")
        await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      else if (paymentStatus === "partially_paid")
        await sql/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
      else if (["failed","expired"].includes(paymentStatus))
        await sql/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;

      return res.status(200).send("ok");
    } catch (err) {
      console.error("NOWPayments webhook error:", err);
      return res.status(500).send("error");
    }
  }
);

/* =======================================
   ROUTER PRINCIPAL (JSON)
   ======================================= */
const router = express.Router();

/** Create intent */
router.post("/payments/create-intent", async (req, res) => {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    if (!NOW_API_KEY) return res.status(500).json({ error: "PSP not configured (NOWPAYMENTS_API_KEY missing)" });

    const { invoiceId, currency, network } = req.body || {};
    if (!invoiceId || !currency) return res.status(400).json({ error: "invoiceId e currency são obrigatórios" });

    const cur = String(currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(cur)) return res.status(400).json({ error: "Moeda inválida" });

    let net = String(network || "").toUpperCase();
    if (cur === "USDC" && !USDC_NETWORKS.includes(net)) return res.status(400).json({ error: "Rede inválida para USDC" });
    if (cur !== "USDC") net = "NATIVE"; // BTC/LTC

    // 1) Lê a fatura e autoriza
    const inv = await invoiceById(Number(invoiceId));
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!canAccess(inv, userId, isAdmin)) return res.status(403).json({ error: "forbidden" });
    if (inv.status === "pago") return res.status(409).json({ error: "Fatura já paga" });

    // 2) Reusar intent ativo
    if (inv.provider_payment_id && inv.status === "aguarda_pagamento") {
      const reusedIsUSDC = String(inv.provider_currency || "").toUpperCase().startsWith("USDC");
      return res.json({
        ok: true,
        intent: {
          invoice_id: inv.id,
          currency: cur,
          network: inv.pay_network || net,
          provider_currency: inv.provider_currency || null,
          amount_fiat: money2Number(inv.subtotal_amount),
          amount_crypto: reusedIsUSDC ? money2Number(inv.subtotal_amount) : inv.pay_amount,
          payment_address: inv.pay_address,
          pay_url: inv.pay_url,
          status: inv.status,
        },
      });
    }

    // 3) Mapeia moeda+rede
    let pay_currency;
    try {
      pay_currency = await mapPayCurrency(cur, net);
    } catch (mapErr) {
      console.warn("[payments] mapPayCurrency failed:", { cur, net, msg: String(mapErr?.message || mapErr) });
      return res.status(400).json({ error: String(mapErr?.message || mapErr) });
    }

    // 4) IPN URL
    let ipnUrl = NOW_IPN_URL;
    if (!ipnUrl) {
      const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
      const host = req.get("x-forwarded-host") || req.get("host");
      ipnUrl = `${proto}://${host}/api/payments/nowpayments`;
    }

    // 5) Cria pagamento no PSP (sem FX quando é USDC)
    const price_amount = money2Number(inv.subtotal_amount);
    const isUSDCSelected = String(pay_currency).toUpperCase().startsWith("USDC");
    // Regra de ouro: se é USDC, price_currency == pay_currency (evita “pay price” inflado)
    const price_currency = isUSDCSelected ? pay_currency : "USD";

    const payload = {
      price_amount,                  // 25.00
      price_currency,                // "USDC"/"USDCBSC" quando é USDC, senão "USD"
      pay_currency,                  // "USDC"/"USDCBSC"/"BTC"/"LTC"
      order_id: `invoice_${inv.id}`,
      order_description: `Energia #${inv.id}`,
      ipn_callback_url: ipnUrl,

      // Cliente paga exatamente o price_amount
      is_fee_paid_by_user: false,
      is_fixed_rate: true,
    };

    let np, raw;
    try {
      const npRes = await fetch(`${NOW_API}/payment`, {
        method: "POST",
        headers: { "x-api-key": NOW_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      raw = await npRes.text();
      try { np = JSON.parse(raw); } catch { np = raw; }
      if (!npRes.ok || !np?.payment_id) {
        const msg = (np && (np.message || np.error || np.errors))
          ? (np.message || np.error || JSON.stringify(np.errors))
          : raw;
        return res.status(502).json({ error: "Erro PSP", provider_error: msg });
      }
    } catch (e) {
      return res.status(502).json({ error: "Erro PSP (network)", detail: String(e?.message || e) });
    }

    // 6) Decide o que GUARDAS (USDC = subtotal; BTC/LTC = PSP)
    const isUSDC = isUSDCSelected; // mesmo check
    const storePayAmount = isUSDC ? Number(price_amount) : (Number(np.pay_amount) || null);
    const storePayAddress = np.pay_address || null;
    const storePayUrl = np.invoice_url || null;
    const providerStatus = normalizeProviderStatus(np.payment_status);

    await txRun(async () => {
      await sql/*sql*/`
        UPDATE energy_invoices
        SET status='aguarda_pagamento',
            provider_payment_id=${Number(np.payment_id)},
            provider_currency=${pay_currency},
            pay_network=${net},
            pay_address=${storePayAddress},
            pay_amount=${storePayAmount},
            pay_url=${storePayUrl},
            updated_at=NOW()
        WHERE id=${inv.id}
      `;
      if (EXTRA_COLS.provider_status) {
        await sql/*sql*/`
          UPDATE energy_invoices
          SET provider_status=${providerStatus}
          WHERE id=${inv.id}
        `;
      }
    });

    return res.json({
      ok: true,
      intent: {
        invoice_id: inv.id,
        currency: cur,
        network: net,
        provider_currency: pay_currency,
        amount_fiat: price_amount,                 // 2 casas
        amount_crypto: storePayAmount,             // USDC: == subtotal_amount
        payment_address: storePayAddress,
        pay_url: storePayUrl,
        status: "pending",
      },
    });
  } catch (err) {
    console.error("create-intent:", err);
    return res.status(500).json({ error: String(err?.message || "Erro interno") });
  }
});

/** Read intent */
router.get("/payments/intent", async (req, res) => {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const inv = await invoiceById(invoiceId);
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!canAccess(inv, userId, isAdmin)) return res.status(403).json({ error: "forbidden" });

    const isUSDCRow = String(inv.provider_currency || "").toUpperCase().startsWith("USDC");

    return res.json({
      ok: true,
      intent: {
        invoice_id: inv.id,
        status: inv.status,
        provider_payment_id: inv.provider_payment_id,
        provider_currency: inv.provider_currency,
        network: inv.pay_network,
        payment_address: inv.pay_address,
        amount_crypto: isUSDCRow ? money2Number(inv.subtotal_amount) : inv.pay_amount,
        amount_fiat: money2Number(inv.subtotal_amount),
        pay_url: inv.pay_url,
      },
    });
  } catch (e) {
    console.error("intent:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

/** Sync (GET or POST) */
async function syncHandler(req, res) {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const invoiceId = Number(req.method === "GET" ? req.query.invoiceId : req.body?.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const inv = await invoiceById(invoiceId);
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!canAccess(inv, userId, isAdmin)) return res.status(403).json({ error: "forbidden" });
    if (!inv.provider_payment_id) return res.status(400).json({ error: "sem provider_payment_id" });

    const r = await fetch(`${NOW_API}/payment/${inv.provider_payment_id}`, {
      headers: { "x-api-key": NOW_API_KEY },
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = p?.message || p?.error || JSON.stringify(p || {});
      return res.status(502).json({ error: "Erro PSP", provider_error: msg });
    }

    const status = normalizeProviderStatus(p.payment_status);

    if (status === "finished") {
      await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      if (EXTRA_COLS.paid_at) {
        await sql/*sql*/`UPDATE energy_invoices SET paid_at=NOW() WHERE id=${invoiceId}`;
      }
    } else if (status === "partially_paid") {
      await sql/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
    } else if (["failed","expired"].includes(status)) {
      await sql/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;
    }
    if (EXTRA_COLS.provider_status) {
      await sql/*sql*/`UPDATE energy_invoices SET provider_status=${status} WHERE id=${invoiceId}`;
    }

    return res.json({ ok: true, provider_status: status });
  } catch (err) {
    console.error("sync:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
router.post("/payments/sync", syncHandler);
router.get("/payments/sync", syncHandler);

/** Status (GET) — simples para UI */
router.get("/payments/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });
    const inv = await invoiceById(invoiceId);
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    const isUSDCRow = String(inv.provider_currency || "").toUpperCase().startsWith("USDC");
    return res.json({
      id: inv.id,
      status: inv.status,
      provider_status: EXTRA_COLS.provider_status ? inv.provider_status ?? null : null,
      amount_fiat: money2Number(inv.subtotal_amount),
      amount_crypto: isUSDCRow ? money2Number(inv.subtotal_amount) : inv.pay_amount,
    });
  } catch (err) {
    console.error("status:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

/** QR code (public) */
router.get("/payments/qr", async (req, res) => {
  try {
    const { address, amount, currency } = req.query;
    if (!address || !currency) return res.status(400).json({ error: "address e currency são obrigatórios" });

    const c = String(currency).toUpperCase();
    let uri = "";
    if (c === "BTC") {
      const amt = amount ? String(amount) : "";
      uri = `bitcoin:${address}${amt ? `?amount=${amt}` : ""}`;
    } else if (c === "LTC") {
      const amt = amount ? String(amount) : "";
      uri = `litecoin:${address}${amt ? `?amount=${amt}` : ""}`;
    } else if (c.startsWith("USDC")) {
      // estáveis: QR é address plain
      uri = `${address}`;
    } else {
      uri = String(address);
    }

    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 300 });

    if (c.startsWith("USDC")) {
      const amtStr = amount != null ? money2String(amount) : null;
      return res.json({ ok: true, qr, amount: amtStr });
    }
    return res.json({ ok: true, qr });
  } catch (err) {
    console.error("qr:", err);
    res.status(500).json({ error: "Erro ao gerar QR" });
  }
});

export default router;
