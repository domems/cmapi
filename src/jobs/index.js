// src/jobs/index.js
import { startUptimeViaBTC } from "./uptimeViaBTC.js";
import { startUptimeLTCPool } from "./uptimeLiteCoinPool.js";
import { startUptimeBinance } from "./uptimeBinance.js";
import { startUptimeF2Pool } from "./uptimeF2Pool.js";
import { startUptimeMiningDutch } from "./uptimeMiningDutch.js";
import { startDeliverPushLoop } from "./deliverPush.js";
import { startDeliverInappLoop } from "./deliverInapp.js";
import { startOfflineReminderLoop } from "./offlineReminder.js";

let started = false;

/** Helper para arrancar jobs com logs uniformes */
function safeStart(name, fn) {
  try {
    fn?.();
    console.log(`✅ [jobs] ${name} started`);
  } catch (e) {
    console.error(`❌ [jobs] ${name} failed:`, e);
  }
}

/** Ponto único de arranque de todos os jobs */
export function startAllJobs() {
  if (started) {
    console.log("[jobs] já iniciado – ignorar nova chamada.");
    return;
  }
  started = true;

  console.log("🚀 Iniciando todos os jobs...");

  /* ---------- UPTIME DETECTION ---------- */
  safeStart("ViaBTC uptime", startUptimeViaBTC);
  safeStart("LitecoinPool uptime", startUptimeLTCPool);
  safeStart("Binance uptime", startUptimeBinance);
  safeStart("F2Pool uptime", startUptimeF2Pool);
  safeStart("MiningDutch uptime", startUptimeMiningDutch);

  /* ---------- BILLING / INVOICES ---------- */
  import("./monthlyClose.js")
    .then((m) => {
      if (m?.startMonthlyClose) {
        m.startMonthlyClose();
        console.log("✅ [jobs] monthlyClose started");
      } else {
        console.log("⚠️ [jobs] monthlyClose não exporta startMonthlyClose()");
      }
    })
    .catch(() => console.log("⚠️ [jobs] monthlyClose.js não encontrado (opcional)."));

  /* ---------- NOTIFICATIONS ---------- */
  safeStart("deliverPush", startDeliverPushLoop);
  safeStart("deliverInapp", startDeliverInappLoop);
  safeStart("offlineReminder", startOfflineReminderLoop);

  console.log("🟢 Todos os jobs agendados com sucesso.");
}
