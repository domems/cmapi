// src/services/prefs.js
import { getClerkUserById } from "./clerkUserService.js";

/**
 * Onde vou buscar as prefs, por ordem de prioridade:
 *  - user.private_metadata.appPrefs
 *  - user.unsafe_metadata.appPrefs
 *  - user.public_metadata.appPrefs
 *  (Fallback: objetos vazios → defaults)
 *
 * Estrutura esperada (flexível, só lê se existir):
 * appPrefs: {
 *   notifications?: {
 *     minerStatusOnline?: boolean,
 *     minerStatusOffline?: boolean,
 *     invoiceClosed?: boolean,
 *     invoiceLate5d?: boolean,
 *     offlineCooldownMin?: number,
 *     channels?: string[]        // ex.: ["push","inapp"]
 *   },
 *   offlineCooldownMin?: number, // fallback se não estiver em notifications
 *   channels?: string[]          // fallback de canais
 * }
 */

function readAppPrefs(user) {
  const pm = user?.private_metadata || user?.privateMetadata || {};
  const um = user?.unsafe_metadata   || user?.unsafeMetadata   || {};
  const pub = user?.public_metadata  || user?.publicMetadata   || {};

  // prioridade: private > unsafe > public
  const appPrefs =
    pm.appPrefs ??
    um.appPrefs ??
    pub.appPrefs ??
    {};

  const n = appPrefs.notifications ?? {};
  return {
    // toggles por tipo
    minerStatusOnline:  n.minerStatusOnline,
    minerStatusOffline: n.minerStatusOffline,
    invoiceClosed:      n.invoiceClosed,
    invoiceLate5d:      n.invoiceLate5d,

    // cooldown
    offlineCooldownMin: Number.isFinite(n.offlineCooldownMin) ? n.offlineCooldownMin
                         : Number.isFinite(appPrefs.offlineCooldownMin) ? appPrefs.offlineCooldownMin
                         : undefined,

    // canais
    channels: Array.isArray(n.channels) ? n.channels
            : Array.isArray(appPrefs.channels) ? appPrefs.channels
            : undefined,
  };
}

/** Mapeia template → chave nas prefs */
function keyForTemplate(template) {
  switch (template) {
    case "miner_offline":          return "minerStatusOffline";
    case "miner_recovered":        return "minerStatusOnline";
    case "miner_offline_reminder": return "minerStatusOffline"; // usa o mesmo toggle do offline
    case "invoice_closed":         return "invoiceClosed";
    case "invoice_late_5d":        return "invoiceLate5d";
    default:                       return null; // desconhecido → default
  }
}

/** O user permite este template? (default = true se não houver pref) */
export async function userAllowsTemplate(userId, template, defaultTrue = true) {
  const user = await getClerkUserById(userId);
  const prefs = readAppPrefs(user);
  const key = keyForTemplate(template);
  if (!key) return defaultTrue;
  const v = prefs[key];
  return typeof v === "boolean" ? v : defaultTrue;
}

/** Canal IN-APP está ligado? (default = true se não configurado) */
export async function channelInappEnabled(userId) {
  const user = await getClerkUserById(userId);
  const prefs = readAppPrefs(user);
  if (!prefs.channels) return true; // sem lista → consideramos ON
  return prefs.channels.includes("inapp");
}

/** Cooldown (minutos) para reminders offline. Default 120 se não existir. */
export async function getCooldownMinutes(userId, fallbackMin = 120) {
  const user = await getClerkUserById(userId);
  const prefs = readAppPrefs(user);
  const n = Number(prefs.offlineCooldownMin);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return fallbackMin;
}
