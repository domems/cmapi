// src/server.js
import express from "express";
import dotenv from "dotenv";
import { sql } from "./config/db.js";
import rateLimiter from "./middleware/rateLimiter.js";
import minerRoutes from "./routes/minersRoutes.js";
import clerkRoutes from "./routes/clerkRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import storeMinersRoutes from "./routes/storeMinersRoutes.js";
import { startAllJobs } from "./jobs/index.js";
import invoicesRoutes from "./routes/invoices.js";
import paymentsRoutes from "./routes/payments.js";
import minersAdminRoutes from "./routes/minersAdminRoutes.js";
import adminInvoicesRouter from "./routes/adminInvoicesRouter.js";
import notificationsRouter from "./routes/notifications.js";
import pushRouter from "./routes/push.js";
import prefsRouter from "./routes/prefs.js";

import { clerkMiddleware } from "@clerk/express";
import authRouter from "./routes/auth.js";
import { adminOnly } from "./middleware/adminOnly.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const app = express();

// Clerk primeiro (popular req.auth)
app.use(clerkMiddleware());

// raw body só no webhook NOWPayments (ANTES do json)
app.use("/api/payments/webhook/nowpayments", express.raw({ type: "*/*" }));

// middlewares gerais
app.use(rateLimiter);
app.use(express.json());

// ---- rotas públicas/gerais ----
app.use("/api/clerk", clerkRoutes);
app.use("/api/miners", minerRoutes);
app.use("/api", statusRoutes);
app.use("/api", storeMinersRoutes);
app.use("/api", invoicesRoutes);
app.use("/api", paymentsRoutes);
app.use("/api", notificationsRouter);
app.use("/api", pushRouter);
app.use("/api", prefsRouter);


// bootstrap de roles
app.use("/api/auth", authRouter);

// ---- rotas ADMIN (protegidas) ----
// ✅ monta em /api/admin (um único /admin no caminho)
app.use("/api/admin", adminOnly, minersAdminRoutes);
app.use("/api/admin", adminOnly, adminInvoicesRouter);

// raiz/health
app.get("/", (_req, res) => res.send("Its working"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

console.log("my port:", process.env.PORT);

// ✅ Cria/actualiza tabela conforme o teu schema real
async function initDB() {
  try {
    // ======= Tua tabela miners (mantido) =======
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
        pool TEXT
      );
    `;
    await sql/*sql*/`
      ALTER TABLE miners
        ALTER COLUMN status SET DEFAULT 'offline';
    `;
    await sql/*sql*/`ALTER TABLE miners DROP COLUMN IF EXISTS data_registo;`;

    // ======= NOVA: Tabela de push tokens =======
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
    await sql/*sql*/`
      CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens(user_id);
    `;

    console.log("✅ DB pronta (miners & push_tokens).");
  } catch (err) {
    console.error("❌ Erro ao preparar a DB:", err);
    process.exit(1);
  }
}

// arranque
initDB().then(() => {
  app.listen(PORT, () => {
    startAllJobs();
    console.log("Server is up and running at port", PORT);
  });
});
