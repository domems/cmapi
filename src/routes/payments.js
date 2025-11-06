import express from "express";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import crypto from "crypto";
import QRCode from "qrcode";
import { sql } from "../config/db.js";

/* ================== ENV ================== */
const NOW_API_KEY    = process.env.NOWPAYMENTS_API_KEY || "";
const NOW_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
const NOW_IPN_URL    = process.env.NOWPAYMENTS_WEBHOOK_URL || "";
const NOW_API        = "https://api.nowpayments.io/v1";

if (!NOW_API_KEY) console.error("[payments] NOWPAYMENTS_API_KEY missing");

/* ================== CONSTS ================== */
const SUPPORTED_CURRENCIES = ["USDC", "BTC", "LTC"];
const USDC_NETWORKS = ["ERC20", "BEP20"];
const CURR_TTL_MS = 15 * 60 * 1000;
let _currCache = { list: null, ts: 0 };

/* ================== MONEY (centavos) ================== */
const toCents = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(",", "."));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100); // round half-up
};
const centsTo2 = (c) => Number((Number(c || 0) / 100).toFixed(2));
const money2 = (v) => centsTo2(toCents(v)); // normaliza para 2 casas

/* ================== DB ================== */
async function invoiceById(id) {
  const [row] = await sql/*sql*/`
    SELECT id, user_id, year, month,
           subtotal_amount, status, currency_code,
           provider_payment_id, provider_currency,
           pay_network, pay_address, pay_amount, pay_url
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

/* ================== OPTIONAL COLS ================== */
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
  } catch (e) {
    console.warn("[payments] optional cols detection failed:", e?.message || e);
  }
})();

/* ================== PSP HELPERS ================== */
async function getNowCurrenciesCached() {
  if (!NOW_API_KEY) throw new Error("PSP not configured");
  const now = Date.now();
  if (_currCache.list && now - _currCache.ts < CURR_TTL_MS) return _currCache.list;
  const r = await fetch(`${NOW_API}/currencies`, { headers: { "x-api-key": NOW_API_KEY } });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) ? (data.message || data.error) : raw;
    throw new Error(`NOW /currencies ${r.status}: ${msg}`);
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
      if (!list.includes("USDC")) throw new Error("USDC(ERC20) indisponível");
      return "USDC";
    }
    if (n === "BEP20") {
      if (!list.includes("USDCBSC")) throw new Error("USDC(BEP20) indisponível");
      return "USDCBSC";
    }
  }
  if (c === "BTC") {
    if (!list.includes("BTC")) throw new Error("BTC indisponível");
    return "BTC";
  }
  if (c === "LTC") {
    if (!list.includes("LTC")) throw new Error("LTC indisponível");
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

/* ===========================================================
   WEBHOOK (monta ANTES do express.json() no server)
   =========================================================== */
export const webhookRouter = express.Router();

const npLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

function verifyNowPayments(req, res, next) {
  try {
    const sigHeader = req.header("x-nowpayments-sig") || req.header("x-signature");
    if (!sigHeader) return res.status(400).send("Missing signature");
    if (!NOW_IPN_SECRET) return res.status(500).send("IPN secret not set");

    const payloadBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const hmac = crypto.createHmac("sha512", NOW_IPN_SECRET).update(payloadBuf).digest("hex");
    const a = Buffer.from(hmac.toLowerCase(), "utf8");
    const b = Buffer.from(String(sigHeader).toLowerCase(), "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send("Invalid signature");

    let parsed;
    try { parsed = JSON.parse(payloadBuf.toString("utf8")); }
    catch { return res.status(400).send("Invalid JSON"); }
    req.ipn = parsed;
    next();
  } catch {
    return res.status(400).send("Invalid webhook");
  }
}

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

      await sql/*sql*/`
        INSERT INTO payments_ipn (provider, external_id, payload)
        VALUES ('nowpayments', ${externalId}, ${sql.json(evt)})
        ON CONFLICT (external_id) DO NOTHING;
      `;

      const orderId = String(evt?.order_id || "");
      const invoiceId = orderId.startsWith("invoice_") ? Number(orderId.replace("invoice_", "")) : null;
      if (!invoiceId) return res.status(200).send("ok");

      const st = normalizeProviderStatus(evt.payment_status);

      if (EXTRA_COLS.provider_status)
        await sql/*sql*/`UPDATE energy_invoices SET provider_status=${st} WHERE id=${invoiceId}`;
      if (st === "finished")
        await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
      else if (st === "partially_paid")
        await sql/*sql*/`UPDATE energy_invoices SET status='aguarda_pagamento' WHERE id=${invoiceId}`;
      else if (["failed","expired"].includes(st))
        await sql/*sql*/`UPDATE energy_invoices SET status='pendente' WHERE id=${invoiceId}`;

      return res.status(200).send("ok");
    } catch (err) {
      console.error("NOWPayments webhook error:", err);
      return res.status(500).send("error");
    }
  }
);

/* =======================================
   ROUTER PRINCIPAL (depois do express.json)
   ======================================= */
const router = express.Router();

/** Create intent (idempotente; usa SEMPRE subtotal_amount em 2 casas) */
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
    if (cur !== "USDC") net = "NATIVE";

    const inv = await invoiceById(Number(invoiceId));
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!canAccess(inv, userId, isAdmin)) return res.status(403).json({ error: "forbidden" });
    if (inv.status === "pago") return res.status(409).json({ error: "Fatura já paga" });

    // Reusar intent ativo
    if (inv.provider_payment_id && inv.status === "aguarda_pagamento") {
      return res.json({
        ok: true,
        intent: {
          invoice_id: inv.id,
          currency: cur,
          network: inv.pay_network || net,
          provider_currency: inv.provider_currency || null,
          amount_fiat: money2(inv.subtotal_amount),
          amount_crypto: inv.pay_amount,
          payment_address: inv.pay_address,
          pay_url: inv.pay_url,
          status: inv.status,
        },
      });
    }

    // Mapeia moeda+rede
    let pay_currency;
    try {
      pay_currency = await mapPayCurrency(cur, net);
    } catch (e) {
      return res.status(400).json({ error: String(e?.message || e) });
    }

    // IPN URL
    let ipnUrl = NOW_IPN_URL;
    if (!ipnUrl) {
      const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
      const host = req.get("x-forwarded-host") || req.get("host");
      ipnUrl = `${proto}://${host}/api/payments/nowpayments`;
    }

    // Montante a cobrar
    const price_amount = money2(inv.subtotal_amount); // 2 casas, sem drift

    // Chamada PSP
    const payload = {
      price_amount,
      price_currency: "USD",
      pay_currency,
      order_id: `invoice_${inv.id}`,
      order_description: `Energia #${inv.id}`,
      ipn_callback_url: ipnUrl,
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

    // Persistir provider data
    await txRun(async () => {
      await sql/*sql*/`
        UPDATE energy_invoices
        SET status='aguarda_pagamento',
            provider_payment_id=${Number(np.payment_id)},
            provider_currency=${pay_currency},
            pay_network=${net},
            pay_address=${np.pay_address || null},
            pay_amount=${np.pay_amount || null},
            pay_url=${np.invoice_url || null},
            updated_at=NOW()
        WHERE id=${inv.id}
      `;
      if (EXTRA_COLS.provider_status) {
        await sql/*sql*/`
          UPDATE energy_invoices
          SET provider_status=${normalizeProviderStatus(np.payment_status)}
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
        amount_fiat: price_amount,
        amount_crypto: np.pay_amount || null,
        payment_address: np.pay_address || null,
        pay_url: np.invoice_url || null,
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
        amount_fiat: money2(inv.subtotal_amount),
        pay_url: inv.pay_url,
      },
    });
  } catch (e) {
    console.error("intent:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

/** Sync (GET/POST) */
async function syncHandler(req, res) {
  const { userId, isAdmin } = getAuthContext(req);
  try {
    const invoiceId = Number(req.method === "GET" ? req.query.invoiceId : req.body?.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });

    const inv = await invoiceById(invoiceId);
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });
    if (!canAccess(inv, userId, isAdmin)) return res.status(403).json({ error: "forbidden" });
    if (!inv.provider_payment_id) return res.status(400).json({ error: "sem provider_payment_id" });

    const r = await fetch(`${NOW_API}/payment/${inv.provider_payment_id}`, { headers: { "x-api-key": NOW_API_KEY } });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = p?.message || p?.error || JSON.stringify(p || {});
      return res.status(502).json({ error: "Erro PSP", provider_error: msg });
    }

    const status = normalizeProviderStatus(p.payment_status);

    if (status === "finished") {
      await sql/*sql*/`UPDATE energy_invoices SET status='pago' WHERE id=${invoiceId}`;
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

/** Status */
router.get("/payments/status", async (req, res) => {
  try {
    const invoiceId = Number(req.query.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId em falta" });
    const inv = await invoiceById(invoiceId);
    if (!inv) return res.status(404).json({ error: "Fatura não encontrada" });

    return res.json({
      id: inv.id,
      status: inv.status,
      provider_status: EXTRA_COLS.provider_status ? inv.provider_status ?? null : null,
      amount_fiat: money2(inv.subtotal_amount),
      amount_crypto: inv.pay_amount,
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
    if (!address || !currency)
      return res.status(400).json({ error: "address e currency são obrigatórios" });

    const c = String(currency).toUpperCase();
    let uri = "";
    if (c === "BTC") {
      const amt = amount ? String(amount) : "";
      uri = `bitcoin:${address}${amt ? `?amount=${amt}` : ""}`;
    } else if (c === "LTC") {
      const amt = amount ? String(amount) : "";
      uri = `litecoin:${address}${amt ? `?amount=${amt}` : ""}`;
    } else if (c === "USDC") {
      uri = `${address}`; // stable: só address
    } else {
      uri = String(address);
    }

    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 300 });

    if (c === "USDC") {
      const amtStr = amount != null ? money2(amount).toFixed(2) : null;
      return res.json({ ok: true, qr, amount: amtStr });
    }

    return res.json({ ok: true, qr });
  } catch (err) {
    console.error("qr:", err);
    res.status(500).json({ error: "Erro ao gerar QR" });
  }
});

export default router;
