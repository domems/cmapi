// src/routes/push.js
import express from "express";
import { upsertPushToken, sendPushToUser } from "../services/push.js";

const router = express.Router();

/**
 * POST /api/push/register
 * body: { userId, email?, token, platform?, appVersion? }
 * Nota: o Clerk já está como global middleware; se quiseres, poderias validar req.auth.userId.
 */
router.post("/push/register", async (req, res) => {
  try {
    const { userId, token, platform, appVersion } = req.body || {};
    if (!userId || !token) {
      return res.status(400).json({ error: "userId and token are required" });
    }
    await upsertPushToken({ userId, token, platform, appVersion });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/register error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/push/test
 * body: { userId, title?, body?, data? }
 * Envia uma notificação de teste para o utilizador.
 */
router.post("/push/test", async (req, res) => {
  try {
    const { userId, title, body, data } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const result = await sendPushToUser(userId, {
      title: title ?? "Test notification",
      body: body ?? "If you see this, push is wired.",
      data: data ?? { reason: "test" },
    });

    return res.json(result);
  } catch (err) {
    console.error("push/test error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
