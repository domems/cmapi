// src/services/push.js
import { Expo } from "expo-server-sdk";
import { sql } from "../config/db.js";

const expo = new Expo();

/** Guarda/atualiza o token (UPSERT por token) */
export async function upsertPushToken({ userId, token, platform, appVersion }) {
  await sql/*sql*/`
    INSERT INTO push_tokens (user_id, token, platform, app_version, last_seen)
    VALUES (${userId}, ${token}, ${platform ?? null}, ${appVersion ?? null}, NOW())
    ON CONFLICT (token)
    DO UPDATE SET user_id = EXCLUDED.user_id,
                  platform = EXCLUDED.platform,
                  app_version = EXCLUDED.app_version,
                  last_seen = NOW()
  `;
}

/** Lista tokens válidos (filtro básico por formato Expo) */
export async function getUserExpoTokens(userId) {
  const rows = await sql/*sql*/`
    SELECT token FROM push_tokens
    WHERE user_id = ${userId}
  `;
  return rows
    .map((r) => r.token)
    .filter((t) => typeof t === "string" && Expo.isExpoPushToken(t));
}

/** Envia notificação para todos os tokens do user (com chunk & limpeza de inválidos) */
export async function sendPushToUser(userId, message /* { title, body, data, sound? } */) {
  const tokens = await getUserExpoTokens(userId);
  if (!tokens.length) return { sent: 0, receipts: [] };

  const messages = tokens.map((to) => ({
    to,
    sound: message.sound ?? "default",
    title: message.title,
    body: message.body,
    data: message.data ?? {},
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const receipts = [];
  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      receipts.push(...res);
    } catch (err) {
      console.error("expo.sendPushNotificationsAsync error:", err);
    }
  }

  // limpeza de tokens inválidos (best-effort, sem checar /receipts endpoint)
  const invalidTokens = receipts
    .map((r, i) => ({ r, token: messages[i]?.to }))
    .filter((x) => x.r?.status === "error" && (x.r?.details?.error === "DeviceNotRegistered" || x.r?.details?.error === "InvalidCredentials"))
    .map((x) => x.token);

  if (invalidTokens.length) {
    await sql/*sql*/`
      DELETE FROM push_tokens
      WHERE token = ANY(${invalidTokens})
    `;
  }

  return { sent: tokens.length, receipts };
}
