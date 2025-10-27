import { Expo } from "expo-server-sdk";
import { sql } from "../config/db.js";

// ⚠️ Android precisa disto em 2024/2025
const expo = new Expo({ useFcmV1: true });

export async function upsertPushToken({ userId, token, platform, appVersion }) {
  await sql/*sql*/`
    INSERT INTO push_tokens (user_id, token, platform, app_version, last_seen)
    VALUES (${userId}, ${token}, ${platform ?? null}, ${appVersion ?? null}, NOW())
    ON CONFLICT (token) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          platform = EXCLUDED.platform,
          app_version = EXCLUDED.app_version,
          last_seen = NOW()
  `;
}

export async function getUserExpoTokens(userId) {
  const rows = await sql/*sql*/`SELECT token FROM push_tokens WHERE user_id=${userId}`;
  return rows.map(r => r.token).filter(t => typeof t === "string" && Expo.isExpoPushToken(t));
}

export async function sendPushToUser(userId, message) {
  const tokens = await getUserExpoTokens(userId);
  if (!tokens.length) return { sent: 0, receipts: [], errors: ["no_valid_tokens"] };

  const messages = tokens.map((to) => ({
    to,
    title: String(message?.title ?? ""),
    body: String(message?.body ?? ""),
    data: message?.data ?? {},
    sound: message?.sound ?? "default",
    // ⚠️ Android precisa de canal que exista no app
    channelId: "default",
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  const errors = [];

  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res);
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
  }

  // conta só os OK
  const okCount = tickets.filter(t => t?.status !== "error" && t?.id).length;

  // limpa tokens mortos imediatamente
  const toDelete = tickets
    .map((t, i) => ({ t, token: messages[i]?.to }))
    .filter(x => x.t?.status === "error" && (x.t?.details?.error === "DeviceNotRegistered" || x.t?.details?.error === "InvalidCredentials"))
    .map(x => x.token);

  if (toDelete.length) {
    await sql/*sql*/`DELETE FROM push_tokens WHERE token = ANY(${toDelete})`;
  }

  // devolve erros úteis para o outbox marcar error/dead
  const ticketErrors = tickets
    .filter(t => t?.status === "error")
    .map(t => `${t?.details?.error || "unknown"}:${t?.message || ""}`);
  if (ticketErrors.length) errors.push(...ticketErrors);

  const receipts = tickets.map(t => t?.id).filter(Boolean);
  return { sent: okCount, receipts, errors };
}
