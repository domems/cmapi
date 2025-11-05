// src/routes/push.js
import express from "express";
import {
  upsertPushToken,
  sendPushToUser,
  heartbeatPush,
  unregisterPush,
} from "../services/push.js";

const router = express.Router();

// POST /api/push/register
router.post("/push/register", async (req, res) => {
  try {
    const { userId, token, platform, appVersion, deviceId, locale, timezone, permissions } = req.body || {};
    if (!userId || !token) return res.status(400).json({ error: "userId and token are required" });

    // Opcional: se tens Clerk no middleware
    // if (req.auth?.userId && req.auth.userId !== userId) {
    //   return res.status(403).json({ error: "forbidden" });
    // }

    const row = await upsertPushToken({
      userId, token, platform, appVersion, deviceId, locale, timezone, permissions,
    });
    return res.json({ ok: true, sub: row });
  } catch (err) {
    console.error("push/register error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/push/heartbeat
router.post("/push/heartbeat", async (req, res) => {
  try {
    const { token, deviceId } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    await heartbeatPush({ token, deviceId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/heartbeat error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/push/unregister
router.post("/push/unregister", async (req, res) => {
  try {
    const { token, deviceId } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    await unregisterPush({ token, deviceId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/unregister error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/push/test
 * body: { userId, title?, body?, data? }
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
