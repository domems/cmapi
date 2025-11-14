// src/jobs/index.js
import { startDeliverPushLoop } from "./deliverPush.js";
import { startDetectStateLoop } from "./detectState.js";
import { startInvoiceLate5dLoop } from "./invoiceLate5d.js";





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
  safeStart("detectState", startDetectStateLoop);
  safeStart("invoiceLate5d", startInvoiceLate5dLoop);
  //safeStart("deliverInapp", startDeliverInappLoop);

  console.log("🟢 Todos os jobs agendados com sucesso.");
}
