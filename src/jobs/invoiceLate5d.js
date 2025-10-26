// src/jobs/invoiceLate5d.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { buildPushFromTemplate } from "../services/notificationTemplates.js";

const TZ = "Europe/Lisbon";

/**
 * Estados considerados "pago" (normalizados):
 * pago, paga, paid, liquidado, liquidada
 */
const PAID_STATES = ["pago", "paga", "paid", "liquidado", "liquidada"];

/** Normaliza o estado (lower/trim). */
function isPaidStatus(s) {
  if (!s) return false;
  const k = String(s).trim().toLowerCase();
  return PAID_STATES.includes(k);
}

/**
 * Lê faturas com >=5 dias e NÃO pagas (estado != paid-synonyms).
 * Usa created_at como "data de fecho", como pediste.
 */
async function fetchOverdueInvoices() {
  // Filtra em SQL (mais eficiente) e volta a validar em JS por segurança.
  const rows = await sql/*sql*/`
    SELECT id, user_id, year, month, subtotal_amount, currency_code, created_at, status
    FROM energy_invoices
    WHERE created_at <= NOW() - INTERVAL '5 days'
      AND NOT (lower(status) = ANY(${sql.array(PAID_STATES, 'text')}))
  `;
  return rows.filter((r) => !isPaidStatus(r.status));
}

/** Devolve chave YYYY-MM-DD segundo a timezone de Lisboa. */
async function getLisbonDayKey() {
  const r = await sql/*sql*/`
    SELECT to_char((NOW() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d
  `;
  return r?.[0]?.d || new Date().toISOString().slice(0, 10);
}

export async function runInvoiceLate5dOnce() {
  const invoices = await fetchOverdueInvoices();
  if (!invoices.length) return { scanned: 0, enqueuedUsers: 0, enqueuedInvoices: 0 };

  const dayKey = await getLisbonDayKey();

  // Agrupa por utilizador
  const byUser = new Map();
  for (const inv of invoices) {
    if (!byUser.has(inv.user_id)) byUser.set(inv.user_id, []);
    byUser.get(inv.user_id).push(inv);
  }

  let userEnqueued = 0;
  let totalInvoices = 0;

  for (const [userId, list] of byUser.entries()) {
    // 1 conjunto/dia/UTILIZADOR (payload contém as invoices)
    const baseDedupe = `invoice:late5d:user:${userId}:${dayKey}`;
    const pushKey    = `${baseDedupe}:push`;
    const inappKey   = `${baseDedupe}:inapp`;

    // Ordena por data, só por estética
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const payload = {
      invoices: list.map((x) => ({
        invoiceId: x.id,
        year: x.year,
        month: x.month,
        subtotal: Number(x.subtotal_amount ?? 0),
        currency: x.currency_code || "USD",
        createdAt: x.created_at,
        status: x.status,
      })),
      atUtc: new Date().toISOString(),
    };

    // 🔔 PUSH (como já fazias)
    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
      VALUES
        (${pushKey}, 'user', ${userId}, 'push', 'invoice_late_5d', ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    // 📰 IN-APP (novo): grava já com title/body/data e marca 'sent'
    const inappPayload = buildPushFromTemplate("invoice_late_5d", payload); // { title, body, data }
    await sql/*sql*/`
      INSERT INTO notification_outbox
        (dedupe_key, audience_kind, audience_ref, channel, template, payload_json, status, send_after_utc)
      VALUES
        (${inappKey}, 'user', ${userId}, 'inapp', 'invoice_late_5d', ${JSON.stringify(inappPayload)}::jsonb, 'sent', NOW())
      ON CONFLICT (dedupe_key) DO NOTHING
    `;

    userEnqueued += 1;
    totalInvoices += list.length;
  }

  return { scanned: invoices.length, enqueuedUsers: userEnqueued, enqueuedInvoices: totalInvoices };
}

export function startInvoiceLate5dLoop() {
  // Todos os dias às 17:30 (hora de Lisboa)
  cron.schedule(
    "30 17 * * *",
    async () => {
      try {
        const r = await runInvoiceLate5dOnce();
        console.log(
          `[invoiceLate5d] scanned=${r.scanned} users=${r.enqueuedUsers} invoices=${r.enqueuedInvoices}`
        );
      } catch (e) {
        console.error("[invoiceLate5d] erro:", e);
      }
    },
    { timezone: TZ }
  );
}
