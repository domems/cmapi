// src/services/prefs.js
import { getClerkUserById } from "./clerkUserService.js";

/**
 * Aceita AMBOS os formatos que usas:
 *
 * 1) appPrefs.notifications.{ minerStatusOnline, minerStatusOffline, minerMaintenance, invoiceClosed, invoiceLate5d, offlineCooldownMin, channels }
 * 2) notifications.{ minerOnline, minerOffline, minerMaintenance, invoiceClosed, invoiceLate5d, offlineCooldownMin, channels }
 *
 * Lê de private_metadata > unsafe_metadata > public_metadata.
 * Defaults: tudo ON se a chave não existir (menos cooldown que tem default 120).
 */

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function readPrefs(user) {
  const pm  = user?.private_metadata || user?.privateMetadata || {};
  const um  = user?.unsafe_metadata   || user?.unsafeMetadata   || {};
  const pub = user?.public_metadata   || user?.publicMetadata   || {};

  const appPrefs   = pm.appPrefs ?? um.appPrefs ?? pub.appPrefs ?? {};
  const appNotifs  = appPrefs.notifications ?? {};
  const flatNotifs = pm.notifications ?? um.notifications ?? pub.notifications ?? {};

  // toggles (sinónimos)
  const minerStatusOnline  = firstDefined(appNotifs.minerStatusOnline,  flatNotifs.minerOnline);
  const minerStatusOffline = firstDefined(appNotifs.minerStatusOffline, flatNotifs.minerOffline);
  const minerMaintenance   = firstDefined(appNotifs.minerMaintenance,   flatNotifs.minerMaintenance);
  const invoiceClosed      = firstDefined(appNotifs.invoiceClosed,      flatNotifs.invoiceClosed);
  const invoiceLate5d      = firstDefined(appNotifs.invoiceLate5d,      flatNotifs.invoiceLate5d);

  // cooldown
  const offlineCooldownMin = firstDefined(
    Number.isFinite(appNotifs.offlineCooldownMin) ? appNotifs.offlineCooldownMin : undefined,
    Number.isFinite(appPrefs.offlineCooldownMin)  ? appPrefs.offlineCooldownMin  : undefined,
    Number.isFinite(flatNotifs.offlineCooldownMin)? flatNotifs.offlineCooldownMin: undefined
  );

  // canais
  const channels = firstDefined(
    Array.isArray(appNotifs.channels) ? appNotifs.channels : undefined,
    Array.isArray(appPrefs.channels)  ? appPrefs.channels  : undefined,
    Array.isArray(flatNotifs.channels)? flatNotifs.channels: undefined
  );

  return {
    minerStatusOnline,
    minerStatusOffline,
    minerMaintenance,
    invoiceClosed,
    invoiceLate5d,
    offlineCooldownMin,
    channels,
  };
}

function keyForTemplate(template) {
  switch (template) {
    case "miner_offline":          return "minerStatusOffline";
    case "miner_recovered":        return "minerStatusOnline";
    case "miner_maintenance":      return "minerMaintenance";
    case "miner_offline_reminder": return "minerStatusOffline";
    case "invoice_closed":         return "invoiceClosed";
    case "invoice_late_5d":        return "invoiceLate5d";
    default:                       return null;
  }
}

/** true/false com default = true se não houver pref */
export async function userAllowsTemplate(userId, template, defaultTrue = true) {
  const user = await getClerkUserById(userId);
  const prefs = readPrefs(user);
  const key = keyForTemplate(template);
  if (!key) return defaultTrue;
  const v = prefs[key];
  return typeof v === "boolean" ? v : defaultTrue;
}

/** in-app ON por omissão se não existir lista; só relevante se voltares a usar in-app */
export async function channelInappEnabled(userId) {
  const user = await getClerkUserById(userId);
  const prefs = readPrefs(user);
  if (!prefs.channels) return true;
  return prefs.channels.includes("inapp");
}

/** cooldown em minutos (default 120) — útil se reativares reminders */
export async function getCooldownMinutes(userId, fallbackMin = 120) {
  const user = await getClerkUserById(userId);
  const prefs = readPrefs(user);
  const n = Number(prefs.offlineCooldownMin);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return fallbackMin;
}
