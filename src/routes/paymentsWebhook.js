import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { sql } from "../config/db.js";

const router = express.Router();

// Limiter específico para webhooks
const npLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function verifyNowPayments(req, res, next) {
  try {
    const sig = req.header("x-nowpayments-sig") || req.header("x-signature");
    if (!sig) return res.status(400).send("Missing signature");
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!secret) return res.status(500).send("IPN secret not set");

    const payloadBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const hmac = crypto.createHmac("sha512", secret).update(payloadBuf).digest("hex");
    if (hmac !== sig) return res.status(401).send("Invalid signature");

    // reparse JSON depois de validar assinatura
    let parsed;
    try {
      parsed = JSON.parse(payloadBuf.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }
    req.ipn = parsed;
    next();
  } catch (e) {
    return res.status(400).send("Invalid webhook");
  }
}

router.post("/nowpayments", npLimiter, verifyNowPayments, async (req, res) => {
  const evt = req.ipn;

  // Idempotência (ajusta o identificador conforme docs/teu payload)
  const externalId =
    String(evt?.payment_id || evt?.invoice_id || evt?.ipn_id || "").trim();
  if (!externalId) return res.status(400).send("Missing external id");

  try {
    await sql/*sql*/`
      INSERT INTO payments_ipn (provider, external_id, payload)
      VALUES ('nowpayments', ${externalId}, ${sql.json(evt)})
      ON CONFLICT (external_id) DO NOTHING;
    `;

    // TODO: aqui fazes a reconciliação segura:
    //  - valida amount, currency, status
    //  - atualiza a fatura/intent numa transação
    //  - dispara notificação idempotente

    return res.status(200).send("ok");
  } catch (err) {
    console.error("NOWPayments webhook error:", err);
    return res.status(500).send("error");
  }
});

export default router;
