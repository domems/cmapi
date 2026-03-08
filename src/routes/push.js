// src/routes/push.js
import express from "express";
import {
  upsertPushToken,
  sendPushToUser,
  heartbeatPush,
  unregisterPush,
} from "../services/push.js";

const router = express.Router();
const EXPO_TOKEN_RE = /^(Expo|Exponent)PushToken\[[^\]]+\]$/;

function authUserId(req) {
  return String(req.userId || req.auth?.userId || "").trim();
}

function roleFromClaims(req) {
  const claims = req.auth?.sessionClaims || {};
  const pm = claims.publicMetadata || claims.public_metadata || {};
  return String(pm.role || "").toLowerCase();
}

function isStaffOrAdmin(req) {
  const role = roleFromClaims(req);
  return role === "admin" || role === "staff";
}

async function registerPushHandler(req, res) {
  try {
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const { userId, token, platform, appVersion, deviceId, locale, timezone, permissions } = req.body || {};
    const targetUserId = String(userId || uid).trim();
    if (!targetUserId || !token) {
      return res.status(400).json({ error: "userId and token are required" });
    }
    if (targetUserId !== uid) {
      return res.status(403).json({ error: "forbidden" });
    }

    const pushToken = String(token).trim();
    if (!EXPO_TOKEN_RE.test(pushToken)) {
      return res.status(400).json({ error: "invalid_push_token" });
    }

    await upsertPushToken({
      userId: targetUserId,
      token: pushToken,
      platform,
      appVersion,
      deviceId,
      locale,
      timezone,
      permissions,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/register error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}

// POST /api/push/register
router.post("/push/register", registerPushHandler);
// Compat legado
router.post("/me/push-token", registerPushHandler);

// POST /api/push/heartbeat
router.post("/push/heartbeat", async (req, res) => {
  try {
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const { token, deviceId } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    await heartbeatPush({ userId: uid, token, deviceId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/heartbeat error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/push/unregister
async function unregisterHandler(req, res) {
  try {
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const { token, deviceId } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    await unregisterPush({ userId: uid, token, deviceId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/unregister error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}

router.post("/push/unregister", unregisterHandler);
// Compat legado
router.post("/push/unregister-token", unregisterHandler);

/**
 * POST /api/push/test
 * body: { userId, title?, body?, data? }
 */
router.post("/push/test", async (req, res) => {
  try {
    if (!isStaffOrAdmin(req)) {
      return res.status(403).json({ error: "forbidden" });
    }

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
