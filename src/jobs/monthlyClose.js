// src/jobs/monthlyClose.js
import cron from "node-cron";
import { sql } from "../config/db.js";
import { redis } from "../config/upstash.js";

const TZ = "Europe/Lisbon";
const MIN_INVOICE_USD = 15; // valor mínimo para fechar fatura

function previousMonthLisbon(baseDate = new Date()) {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth() + 1;
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}

async function getOrCreateInvoiceId(userId, year, month) {
  const existing = await sql/*sql*/`
    SELECT id FROM energy_invoices
    WHERE user_id = ${userId} AND year = ${year} AND month = ${month}
    LIMIT 1
  `;
  if (existing[0]?.id) return existing[0].id;

  const inserted = await sql/*sql*/`
    INSERT INTO energy_invoices (user_id, year, month, subtotal_amount, status, currency_code)
    VALUES (${userId}, ${year}, ${month}, 0, 'pendente', 'USD')
    RETURNING id
  `;
  return inserted[0]?.id;
}

async function enqueueInvoiceClosed(userId, invoiceId, year, month, subtotal, currency = "USD") {
  const mm = String(month).padStart(2, "0");
  const dedupe = `invoice:${userId}:${year}-${mm}:closed`;

  const payload = {
    invoiceId,
    year,
    month,
    subtotal,
    currency,
    atUtc: new Date().toISOString(),
  };

  // Enfileira push; deliverPush trata das prefs (invoice_closed)
  await sql/*sql*/`
    INSERT INTO notification_outbox
      (dedupe_key, audience_kind, audience_ref, channel, template, payload_json)
    VALUES
      (${dedupe}, 'user', ${userId}, 'push', 'invoice_closed', ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING
  `;
}

async function closeMonthOnce(year, month) {
  const today = new Date();
  const lockKey = `monthly-close:${year}-${String(month).padStart(2, "0")}-${today.getDate()}`;
  const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 60 * 60 });
  if (!gotLock) {
    console.log(`[monthlyClose] lock ativo ${year}-${month}, a ignorar duplicado.`);
    return;
  }

  const miners = await sql/*sql*/`
    SELECT
      id,
      user_id,
      nome,
      COALESCE(total_horas_online, 0)  AS hours,
      COALESCE(consumo_kw_hora, 0)     AS consumo_kw_hora,
      COALESCE(preco_kw, 0)            AS preco_kw
    FROM miners
  `;

  const byUser = new Map();
  for (const m of miners) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m);
  }

  for (const [userId, list] of byUser.entries()) {
    let subtotal = 0;

    for (const m of list) {
      const hours = Number(m.hours) || 0;
      const consumo = Number(m.consumo_kw_hora) || 0;
      const preco = Number(m.preco_kw) || 0;
      const kwh = +(hours * consumo).toFixed(3);
      const amount = +(kwh * preco).toFixed(2);
      subtotal += amount;
    }

    if (subtotal < MIN_INVOICE_USD) {
      console.log(`[monthlyClose] user=${userId} subtotal=${subtotal} < ${MIN_INVOICE_USD}, não gera fatura.`);
      continue; // não cria invoice nem reseta horas
    }

    const invoiceId = await getOrCreateInvoiceId(userId, year, month);
    if (!invoiceId) {
      console.warn(`[monthlyClose] falha ao criar/obter invoice para user=${userId} ${month}/${year}`);
      continue;
    }

    // recriar itens
    for (const m of list) {
      const hours = Number(m.hours) || 0;
      const consumo = Number(m.consumo_kw_hora) || 0;
      const preco = Number(m.preco_kw) || 0;
      const kwh = +(hours * consumo).toFixed(3);
      const amount = +(kwh * preco).toFixed(2);

      await sql/*sql*/`
        INSERT INTO energy_invoice_items
          (invoice_id, miner_id, miner_nome, hours_online, kwh_used, preco_kw, consumo_kw_hora, amount_eur)
        VALUES
          (${invoiceId}, ${m.id}, ${m.nome || `Miner#${m.id}`}, ${hours}, ${kwh}, ${preco}, ${consumo}, ${amount})
        ON CONFLICT (invoice_id, miner_id) DO UPDATE SET
          miner_nome       = EXCLUDED.miner_nome,
          hours_online     = EXCLUDED.hours_online,
          kwh_used         = EXCLUDED.kwh_used,
          preco_kw         = EXCLUDED.preco_kw,
          consumo_kw_hora  = EXCLUDED.consumo_kw_hora,
          amount_eur       = EXCLUDED.amount_eur
      `;
    }

    await sql/*sql*/`
      UPDATE energy_invoices
      SET subtotal_amount = ${+subtotal.toFixed(2)}::numeric,
          status = 'pendente',
          updated_at = NOW()
      WHERE id = ${invoiceId}
    `;

    // reset horas SÓ deste utilizador
    await sql/*sql*/`
      UPDATE miners SET total_horas_online = 0 WHERE user_id = ${userId}
    `;

    // 🔔 Enfileira notificação de fecho (end of month)
    await enqueueInvoiceClosed(userId, invoiceId, year, month, +subtotal.toFixed(2), "USD");

    console.log(`✅ Fecho mensal user=${userId} total=${subtotal} USD`);
  }

  console.log(`✅ Fecho mensal concluído para ${month}/${year}`);
}

export function startMonthlyClose() {
  cron.schedule(
    "05 00 1 * *",
    async () => {
      try {
        const { year, month } = previousMonthLisbon();
        await closeMonthOnce(year, month);
      } catch (e) {
        console.error("⛔ monthlyClose:", e);
      }
    },
    { timezone: TZ }
  );
}

export async function runMonthlyCloseNow() {
  const { year, month } = previousMonthLisbon();
  await closeMonthOnce(year, month);
}
