// src/server.js
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { clerkMiddleware, requireAuth } from "@clerk/express";

import { adminOrStaffOnly } from "./middleware/roles.js";
import { staffOrAdmin } from "./middleware/staffOnly.js";
import rateLimiter from "./middleware/rateLimiter.js";
import { preListCache } from "./middleware/preListCache.js";
import { listarMinersPorUser } from "./controllers/minersController.js";
import { sql } from "./config/db.js";
import { startAllJobs } from "./jobs/index.js";

/* ===== Rotas ===== */
import minerRoutes from "./routes/minersRoutes.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMinersRoutes.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes, { webhookRouter as paymentsWebhookRouter } from "./routes/payments.js";
import minersAdminRoutes from "./routes/minersAdminRoutes.js";
import adminInvoicesRouter from "./routes/adminInvoicesRouter.js";
import notificationsRouter from "./routes/notifications.js";
import pushRouter from "./routes/push.js";
import prefsRouter from "./routes/prefs.js";
import authRouter from "./routes/auth.js";
import staffRouter from "./routes/staff.js"; // <-- isto faltava/estava errado no teu deploy

dotenv.config();

const PORT = Number(process.env.PORT || 5001);
const ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

function authUserId(req) {
  return String(req.auth?.userId || req.auth?.sessionClaims?.sub || "").trim();
}

/* ================= Segurança base ================= */
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: false,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
  })
);

app.use(
  cors({
    origin(origin, cb) {
      // apps nativas (sem Origin) e origens whitelisted
      if (!origin || ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS origin not allowed"));
    },
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  })
);

/* ================= Logger (pino) ================= */
const logger = pino({
  level: process.env.LOG_LEVEL || "warn",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.headers.x-user-email",
    "req.body.secret_key",
    "req.body.api_key",
  ],
});
app.use(
  pinoHttp({
    logger,
    serializers: { err: pino.stdSerializers.err },
    autoLogging: {
      ignore: (req) => {
        const u = req.url || "";
        return (
          u === "/" ||
          u === "/api/healthz" ||
          u.startsWith("/favicon.ico") ||
          u.startsWith("/assets/")
        );
      },
    },
  })
);

/* =========================================================
   WEBHOOK NOWPayments — RAW body ANTES de Clerk/JSON
   Caminho público: POST /api/payments/nowpayments
   ========================================================= */
app.post(
  "/api/payments/nowpayments",
  // RAW para o HMAC (aceita application/json e application/*+json)
  express.raw({ type: ["application/json", "application/*+json"], limit: "512kb" }),
  paymentsWebhookRouter // o router de payments valida HMAC e trata o IPN
);

/* ================= Clerk e body parsers (depois do webhook) ================= */
app.use(clerkMiddleware());
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false, limit: "200kb" }));

/* ================= Rate-limit específico: lista de miners ================= */
const minersListLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.auth?.userId) return `uid:${req.auth.userId}`;
    return ipKeyGenerator(req);
  },
  handler: (_req, res) => {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ message: "Too many requests, please try again later :)" });
  },
  skip: (req) => req.method === "OPTIONS" || req.method === "HEAD",
});

/* ================= Rotas especiais ANTES do limiter global ================= */
app.get(
  "/api/miners/user/:userId",
  requireAuth(),
  (req, res, next) => {
    // bloqueio cross-tenant
    const param = String(req.params.userId);
    const uid = authUserId(req);
    if (!uid || uid !== param) return res.status(403).json({ error: "Forbidden" });
    return next();
  },
  preListCache(),
  minersListLimiter,
  listarMinersPorUser
);

/* ================= Middlewares/rotas do resto da app ================= */
// Limiter global
app.use(rateLimiter);

// públicas/gerais
app.use("/api/clerk", requireAuth(), adminOrStaffOnly, clerkRoutes);
app.use("/api", statusRoutes);
app.use("/api", requireAuth(), adminOrStaffOnly, storeMinersRoutes);

// Payments normal (create-intent, intent, sync, qr)
app.use("/api", paymentsRoutes);

// rotas com auth do utilizador
function userScope(req, _res, next) {
  const uid = authUserId(req);
  if (!uid) return next(new Error("Missing auth"));
  req.userId = uid;
  next();
}
app.use("/api/miners", requireAuth(), userScope, minerRoutes);
app.use("/api", requireAuth(), userScope, invoicesRoutes);
app.use("/api", requireAuth(), userScope, notificationsRouter);
app.use("/api", requireAuth(), userScope, pushRouter);
app.use("/api", requireAuth(), userScope, prefsRouter);

// auth bootstrap
app.use("/api/auth", authRouter);

// rotas ADMIN (sessão + role na Clerk)
app.use("/api/admin", requireAuth(), adminOrStaffOnly, minersAdminRoutes);
app.use("/api/admin", requireAuth(), adminOrStaffOnly, adminInvoicesRouter);

// rotas STAFF (sessão + role)
app.use("/api/staff", requireAuth(), staffOrAdmin(), staffRouter);

/* ================= Raiz/health ================= */
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=60");
  return res.status(204).end();
});
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

/* ================= 404 e Error handler ================= */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, _next) => {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  req.log?.error({ err }, "Unhandled error");
  res
    .status(status)
    .json({ error: status === 500 ? "Internal error" : String(err.message || "Error") });
});

/* ================= DB bootstrap ================= */
async function initDB() {
  try {
    logger.info("✅ DB pronta.");
  } catch (err) {
    console.error("❌ Erro ao preparar a DB:", err);
    process.exit(1);
  }
}

/* ================= Arranque ================= */
const isVercelRuntime = process.env.VERCEL === "1";

if (!isVercelRuntime) {
  initDB().then(() => {
    const server = app.listen(PORT, () => {
      logger.info(`HTTP listening on :${PORT}`);
      startAllJobs();
    });

    // timeouts para travar slowloris
    server.headersTimeout = 65_000;
    server.requestTimeout = 60_000;
  });
}

export default app;
