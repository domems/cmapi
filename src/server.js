// src/server.js
import express from "express";
import dotenv from "dotenv";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import { startAllJobs } from "./jobs/index.js";
import { sql } from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";

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
import adminOnly from "./middleware/adminOnly.js";

import { preListCache } from "./middleware/preListCache.js";       // <<< mantém
import { listarMinersPorUser } from "./controllers/minersController.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const app = express();

/* ================= Clerk e body parsers ================= */
// Clerk primeiro (popular req.auth)
app.use(clerkMiddleware());

// raw body só no webhook NOWPayments (ANTES do json)
app.use("/api/payments/webhook/nowpayments", express.raw({ type: "*/*" }));

// JSON parser para o resto
app.use(express.json());

/* ================= Rota especial com pré-cache antes do limiter =================
   — Serve 304/200 a partir de cache sem “gastar” rate-limit.
   — Se não houver cache fresco, cai no handler normal com um limiter dedicado.
*/
const minersListLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
    if (req.params?.userId) return `user:${req.params.userId}`;
    if (req.headers["x-user-email"]) {
      return `email:${String(req.headers["x-user-email"]).toLowerCase()}`;
    }
    // IPv6-safe
    return ipKeyGenerator(req);
  },

  handler: (req, res) => {
    const retry = 60; // segundos
    res.setHeader("Retry-After", String(retry));
    res.status(429).json({ message: "Too many requests, please try again later :)" });
  },

  skip: (req) => req.method === "OPTIONS" || req.method === "HEAD",
});

// ⚠️ IMPORTANTE: esta rota vem ANTES do limiter global
app.get("/api/miners/user/:userId", preListCache(), minersListLimiter, listarMinersPorUser);

/* ================= Middlewares/rotas do resto da app ================= */
// Limiter global (aplica-se a tudo o resto)
app.use(rateLimiter);

// ---- rotas públicas/gerais (ou que precisam de exceções) ----
app.use("/api/clerk", clerkRoutes);

// Pagamentos: mantém sem requireAuth para não partir o webhook.
// (Dentro do router, protege endpoints sensíveis; o webhook fica público.)
app.use("/api", paymentsRoutes);

// ---- rotas autenticadas (Clerk requireAuth) ----
app.use("/api/miners", requireAuth(), minerRoutes);
app.use("/api", requireAuth(), statusRoutes);
app.use("/api", requireAuth(), storeMinersRoutes);
app.use("/api", requireAuth(), invoicesRoutes);
app.use("/api", requireAuth(), notificationsRouter);
app.use("/api", requireAuth(), pushRouter);
app.use("/api", requireAuth(), prefsRouter);

// Bootstrap/gestão de roles (restrito a admin)
app.use("/api/auth", requireAuth(), adminOnly, authRouter);

// ---- rotas ADMIN (protegidas) ----
app.use("/api/admin", requireAuth(), adminOnly, minersAdminRoutes);
app.use("/api/admin", requireAuth(), adminOnly, adminInvoicesRouter);

// raiz/health
app.get("/", (_req, res) => res.send("Its working"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

console.log("my port:", process.env.PORT);

/* ================= DB bootstrap ================= */
async function initDB() {
  try {
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
    await sql/*sql*/`
      ALTER TABLE miners
        ALTER COLUMN status SET DEFAULT 'offline';
    `;
    await sql/*sql*/`ALTER TABLE miners DROP COLUMN IF EXISTS data_registo;`;

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

    console.log("✅ DB pronta (miners & push_tokens).");
  } catch (err) {
    console.error("❌ Erro ao preparar a DB:", err);
    process.exit(1);
  }
}

/* ================= Arranque ================= */
initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server is up and running at port", PORT);
    startAllJobs();
  });
});
