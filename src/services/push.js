// src/services/push.js
import { Expo } from "expo-server-sdk";
import { sql } from "../config/db.js";

const expo = new Expo({ useFcmV1: true });

/** Upsert idempotente (por token) + estado + device_id + timestamps */
export async function upsertPushToken({ userId, token, platform, appVersion, deviceId }) {
  if (!userId || !token) throw new Error("userId/token missing");

  await sql/*sql*/`
    INSERT INTO push_tokens (user_id, token, platform, app_version, device_id, status, last_seen, updated_at)
    VALUES (${userId}, ${token}, ${platform ?? null}, ${appVersion ?? null}, ${deviceId ?? null}, 'active', now(), now())
    ON CONFLICT (token) DO UPDATE
      SET user_id    = EXCLUDED.user_id,
          platform   = COALESCE(EXCLUDED.platform, push_tokens.platform),
          app_version= COALESCE(EXCLUDED.app_version, push_tokens.app_version),
          device_id  = COALESCE(EXCLUDED.device_id, push_tokens.device_id),
          status     = 'active',
          last_seen  = now(),
          updated_at = now()
  `;
}

/** Heartbeat para manter last_seen fresco */
export async function heartbeatPush({ token, deviceId }) {
  if (!token) return;
  await sql/*sql*/`
    UPDATE push_tokens
       SET last_seen = now(), updated_at = now()
     WHERE token = ${token} AND (device_id IS NULL OR device_id = ${deviceId ?? null})
  `;
}

/** Marca como revogado (logout/perms off) */
export async function unregisterPush({ token, deviceId }) {
  if (!token) return;
  await sql/*sql*/`
    UPDATE push_tokens
       SET status='revoked', updated_at=now()
     WHERE token=${token} AND (device_id IS NULL OR device_id=${deviceId ?? null})
  `;
}

/** Só tokens ativos e válidos Expo */
export async function getUserExpoTokens(userId) {
  const rows = await sql/*sql*/`
    SELECT token FROM push_tokens
     WHERE user_id=${userId} AND status='active'
  `;
  return rows
    .map(r => r.token)
    .filter(t => typeof t === "string" && Expo.isExpoPushToken(t));
}

/** Envia push a um user (com receipts + marcação bounced) */
export async function sendPushToUser(userId, message) {
  const tokens = await getUserExpoTokens(userId);
  if (!tokens.length) return { sent: 0, receipts: [], errors: ["no_valid_tokens"] };

  const messages = tokens.map((to) => ({
    to,
    title: String(message?.title ?? ""),
    body: String(message?.body ?? ""),
    data: message?.data ?? {},
    sound: message?.sound ?? "default",
    channelId: "default", // Android
    priority: "default",
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  const errors = [];

  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res);
    } catch (e) {
      errors.push(`send_chunk:${String(e?.message ?? e)}`);
    }
  }

  // Limpa erros imediatos (não apagar, marcar bounced)
  const immediateBounced = tickets
    .map((t, i) => ({ t, token: messages[i]?.to }))
    .filter(x => x.t?.status === "error" && ["DeviceNotRegistered", "InvalidCredentials"].includes(x.t?.details?.error))
    .map(x => x.token);

  if (immediateBounced.length) {
    await sql/*sql*/`
      UPDATE push_tokens SET status='bounced', updated_at=now()
      WHERE token = ANY(${immediateBounced})
    `;
  }

  // Receipts tardios (apanha erros pós-enfileiramento)
  const receiptIds = tickets.map(t => t?.id).filter(Boolean);
  const receiptChunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of receiptChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      // receipts é um map id-> { status, details? }
      const bounced = [];
      for (const [id, info] of Object.entries(receipts)) {
        if (info?.status === "error") {
          const maybeToken = messages[ tickets.findIndex(t => t?.id === id) ]?.to;
          const fatal =
            info?.details?.error === "DeviceNotRegistered" ||
            info?.details?.error === "InvalidCredentials";
          if (fatal && maybeToken) bounced.push(maybeToken);
          errors.push(`receipt:${info?.details?.error || "unknown"}`);
        }
      }
      if (bounced.length) {
        await sql/*sql*/`
          UPDATE push_tokens SET status='bounced', updated_at=now()
          WHERE token = ANY(${bounced})
        `;
      }
    } catch (e) {
      errors.push(`receipts_chunk:${String(e?.message ?? e)}`);
    }
  }

  const okCount = tickets.filter(t => t?.status !== "error" && t?.id).length;
  return { sent: okCount, receipts: receiptIds, errors };
}
