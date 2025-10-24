// src/jobs/invoiceLate5d.js
import cron from "node-cron";
import { sql } from "../config/db.js";

const TZ = "Europe/Lisbon";

/**
 * Enfileira uma notificação diária às 17:30 (Lisboa)
 * para cada fatura criada há >= 5 dias e ainda não paga.
 * deliverPush filtra prefs (invoice_late_5d).
 */
export async function runInvoiceLate5dOnce() {
  const rows = await sql/*sql*/`
    SELECT id, user_id, year, month, subtotal_amount, currency_code, created_at
    FROM energy_invoices
    WHERE status <> 'paid'
      AND created_at <= NOW() - INTERVAL '5 days'
  `;

  if (!rows.length) return { scanned: 0, enqueued: 0 };

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(now.getUTCDate()).padStart(2, "0");
  const dayKey = `${yyyy}-${mm}-${dd}`;

  let enqueued = 0;

  for (const inv of rows) {
    const dedupe = `invoice:${inv.id}:late5d:${dayKey}`; // 1 push/dia/fatura
    const payload = {
      invoiceId: inv.id,
      year: inv.year,
      month: inv.month,
      subtotal: Number(inv.subtotal_amount ?? 0),
      currency: inv.currency_code || "USD",
      atUtc: now.toISOString(),
    };

    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${dedupe}, 'user', ${inv.user_id}, 'push', 'invoice_late_5d', ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    enqueued++;
  }

  return { scanned: rows.length, enqueued };
}

export function startInvoiceLate5dLoop() {
  // Todos os dias às 17:30 hora de Lisboa
  cron.schedule(
    "30 17 * * *",
    async () => {
      try {
        const r = await runInvoiceLate5dOnce();
        console.log(`[invoiceLate5d] scanned=${r.scanned} enqueued=${r.enqueued}`);
      } catch (e) {
        console.error("[invoiceLate5d] erro:", e);
      }
    },
    { timezone: TZ }
  );
}
