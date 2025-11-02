import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import crypto from "crypto";

import { startAllJobs } from "./jobs/index.js";
import { sql } from "./config/db.js";

// --- teus middlewares/rotas existentes ---
import rateLimiter from "./middleware/rateLimiter.js"; // GLOBAL
import { preListCache } from "./middleware/preListCache.js"; // mantém
import { listarMinersPorUser } from "./controllers/minersController.js";

import minerRoutes from "./routes/minersRoutes.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMinersRoutes.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes from "./routes/payments.js";
import minersAdminRoutes from "./routes/minersAdminRoutes.js";
import adminInvoicesRouter from "./routes/adminInvoicesRouter.js";
import notificationsRouter from "./routes/notifications.js";
import pushRouter from "./routes/push.js";
import prefsRouter from "./routes/prefs.js";
import authRouter from "./routes/auth.js";
import paymentsWebhookRouter from "./routes/paymentsWebhook.js";

import { adminOnly } from "./middleware/adminOnly.js";

dotenv.config();

const PORT = Number(process.env.PORT || 5001);
const ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean); // ex.: "https://app.cryptominers.pt,https://admin.cryptominers.pt"

const app = express();

/* ================= Segurança base ================= */
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: false,
  frameguard: { action: "deny" },
  referrerPolicy: { policy: "no-referrer" },
}));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // apps nativas (sem origin)
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS origin not allowed"));
  },
  credentials: true,
  allowedHeaders: ["authorization","content-type","x-request-id"],
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  maxAge: 600,
}));

// Logs com redaction
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.body.secret_key",
    "req.body.api_key",
  ],
});
app.use(pinoHttp({ logger, serializers: { err: pino.stdSerializers.err } }));

/* ================= Clerk e body parsers ================= */
app.use(clerkMiddleware());

// Webhook NOWPayments — precisa de raw body (ANTES do json)
app.use("/api/payments/webhook/nowpayments", express.raw({ type: "*/*", limit: "256kb" }));

// JSON parser para o resto
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false, limit: "200kb" }));

/* ================= Rate-limit específico da lista de miners ================= */
const minersListLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // se já tiveres user auth, usa userId; se não, IP
    if (req.auth?.userId) return `uid:${req.auth.userId}`;
    return ipKeyGenerator(req);
  },
  handler: (req, res) => {
    const retry = 60;
    res.setHeader("Retry-After", String(retry));
    res.status(429).json({ message: "Too many requests, please try again later :)" });
  },
  skip: (req) => req.method === "OPTIONS" || req.method === "HEAD",
});

/* ================= Rota especial com pré-cache ANTES do limiter global ================= */
app.get(
  "/api/miners/user/:userId",
  requireAuth(),
  preListCache(),
  minersListLimiter,
  (req, res, next) => {
    // bloqueia cross-tenant: só o próprio user pode pedir
    const param = String(req.params.userId);
    const uid = req.auth?.userId;
    if (!uid || uid !== param) return res.status(403).json({ error: "Forbidden" });
    return listarMinersPorUser(req, res, next);
  }
);

/* ================= Middlewares/rotas do resto da app ================= */
// Limiter global (aplica-se a tudo o que vem a seguir)
app.use(rateLimiter);

// ---- rotas públicas/gerais ----
app.use("/api/clerk", clerkRoutes);
app.use("/api", statusRoutes);
app.use("/api", storeMinersRoutes);

// Webhook validado (HMAC) — já tem raw body
app.use("/api/payments/webhook", paymentsWebhookRouter);

// ---- rotas com auth do utilizador ----
function userScope(req, _res, next) {
  const uid = req.auth?.userId;
  if (!uid) return next(new Error("Missing auth"));
  req.userId = uid;
  next();
}

app.use("/api/miners", requireAuth(), userScope, minerRoutes);
app.use("/api/invoices", requireAuth(), userScope, invoicesRoutes);
app.use("/api/notifications", requireAuth(), userScope, notificationsRouter);
app.use("/api/push", requireAuth(), userScope, pushRouter);
app.use("/api/prefs", requireAuth(), userScope, prefsRouter);

// bootstrap de roles (se tiver endpoints públicos de role seeding, mantém aqui)
app.use("/api/auth", authRouter);

// ---- rotas ADMIN (protegidas por sessão + role) ----
app.use("/api/admin", requireAuth(), adminOnly, minersAdminRoutes);
app.use("/api/admin", requireAuth(), adminOnly, adminInvoicesRouter);

// raiz/health
app.get("/", (_req, res) => res.send("Its working"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

/* ================= 404 e Error handler ================= */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  req.log?.error({ err }, "Unhandled error");
  res.status(status).json({ error: status === 500 ? "Internal error" : String(err.message || "Error") });
});

/* ================= DB bootstrap ================= */
async function initDB() {
  try {
    // Extensão pgcrypto (melhor esforço)
    try {
      await sql/*sql*/`CREATE EXTENSION IF NOT EXISTS pgcrypto;`;
    } catch (e) {
      console.warn("⚠️ Não foi possível criar extensão pgcrypto (continua sem falhar):", e?.message || e);
    }

    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS miners (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        nome TEXT NOT NULL,
        modelo TEXT,
        hash_rate TEXT,
        worker_name TEXT,
        status TEXT DEFAULT 'offline',
        preco_kw NUMERIC,
        consumo_kw_hora NUMERIC,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        total_horas_online NUMERIC DEFAULT 0,
        api_key TEXT,
        secret_key TEXT,
        coin TEXT,
        pool TEXT,
        updated_at TIMESTAMP WITHOUT TIME ZONE
      );
    `;
    await sql/*sql*/`ALTER TABLE miners ALTER COLUMN status SET DEFAULT 'offline';`;
    await sql/*sql*/`ALTER TABLE miners DROP COLUMN IF EXISTS data_registo;`;
    await sql/*sql*/`CREATE INDEX IF NOT EXISTS miners_user_id_idx ON miners(user_id);`;
    await sql/*sql*/`CREATE INDEX IF NOT EXISTS miners_worker_name_idx ON miners(worker_name);`;

    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT,
        app_version TEXT,
        last_seen TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await sql/*sql*/`CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens(user_id);`;

    // Idempotência simples para webhooks (ajusta nomes conforme o teu schema)
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS payments_ipn (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL UNIQUE, -- ex: ipn_id/transaction/invoice
        payload JSONB NOT NULL,
        received_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    console.log("✅ DB pronta.");
  } catch (err) {
    console.error("❌ Erro ao preparar a DB:", err);
    process.exit(1);
  }
}

/* ================= Arranque ================= */
await initDB();

const server = app.listen(PORT, () => {
  logger.info({ PORT }, "Server is up and running");
  const RUN_JOBS = process.env.RUN_JOBS === "1";
  if (RUN_JOBS) {
    logger.info("Starting background jobs (RUN_JOBS=1)...");
    startAllJobs();
  } else {
    logger.info("Background jobs disabled in this process (RUN_JOBS!=1)");
  }
});

// timeouts para travar slowloris
server.headersTimeout = 65_000;
server.requestTimeout = 60_000;
