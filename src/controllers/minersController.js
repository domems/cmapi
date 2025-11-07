// src/controllers/minersController.js
import { sql } from "../config/db.js";
import {
  setCachedList,
  invalidateUserList,
} from "../services/minersListCache.js";

/* ===================== Helpers ===================== */

function normalizeDecimal(input) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Valor numérico inválido: "${input}"`);
    return input;
  }
  const s0 = String(input).trim().replace(/\s+/g, "");
  let s = s0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    const decSep = lastComma > lastDot ? "," : ".";
    const thouSep = decSep === "," ? /\./g : /,/g;
    s = s.replace(thouSep, "").replace(decSep, ".");
  } else if (hasComma) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: "${input}"`);
  return n;
}

/** Garante que :id é inteiro (evita 22P02 no Postgres) */
function parseIntIdOr400(req, res) {
  const raw = req.params?.id;
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    res.status(400).json({ error: "Parâmetro id inválido (tem de ser inteiro)." });
    return null;
  }
  return num;
}

const TAG = "[MINER-STATE-HISTORY]";
const ALLOWED_STATES = new Set(["ONLINE","OFFLINE","MAINTENANCE","STALE"]);

export async function getMinerStateHistory(req, res) {
  try {
    const minerId = Number(req.params.id);
    const rawLimit = Number(req.query.limit || 50);
    const limit = Math.max(1, Math.min(rawLimit, 200));

    if (!Number.isInteger(minerId)) {
      return res.status(400).json({ error: "invalid miner id" });
    }

    const rows = await sql/*sql*/`
      SELECT
        id,
        miner_id,
        from_state,
        to_state,
        slot_iso,
        occurred_at_utc,
        reason
      FROM miner_state_events
      WHERE miner_id = ${minerId}
      ORDER BY occurred_at_utc DESC
      LIMIT ${limit};
    `;

    // aceitar from_state NULL, validar to_state
    const safe = rows.filter(r =>
      ALLOWED_STATES.has((r.to_state || "").toUpperCase()) &&
      (r.from_state == null || ALLOWED_STATES.has((r.from_state || "").toUpperCase()))
    );

    console.log(TAG, { minerId, got: rows.length, safe: safe.length });
    return res.status(200).json({ items: safe }); // <- SEMPRE 200
  } catch (e) {
    try { console.error(TAG, e); } catch {}
    return res.status(500).json({ error: "failed to fetch miner state history" });
  }
}




/* ========== Atualização por cliente (campos do cliente) ========== */
export const atualizarMinerComoCliente = async (req, res) => {
  const id = parseIntIdOr400(req, res);
  if (id === null) return;

  const { worker_name, api_key, secret_key, coin, pool } = req.body || {};

  try {
    const [curr] = await sql/*sql*/`
      SELECT id, user_id, locked, worker_name AS w, api_key AS a, secret_key AS s, coin AS c, pool AS p
      FROM miners
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!curr) return res.status(404).json({ error: "Miner não encontrada." });
    if (curr.locked === true) {
      return res.status(423).json({ error: "Registo bloqueado pelo admin (locked=true)." });
    }

    const finalPool = pool !== undefined ? pool : curr.p;
    const finalApi  = api_key !== undefined ? api_key : curr.a;
    const finalSec  = secret_key !== undefined ? secret_key : curr.s;

    if (String(finalPool || "").toLowerCase() === "binance" && (!finalApi || !finalSec)) {
      return res.status(400).json({ error: "Para Binance, api_key e secret_key são obrigatórias." });
    }

    const [updatedMiner] = await sql/*sql*/`
      UPDATE miners
      SET
        worker_name = COALESCE(${worker_name ?? null}, worker_name),
        api_key     = COALESCE(${api_key ?? null}, api_key),
        secret_key  = COALESCE(${secret_key ?? null}, secret_key),
        coin        = COALESCE(${coin ?? null}, coin),
        pool        = COALESCE(${pool ?? null}, pool),
        updated_at  = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;

    if (updatedMiner?.user_id) invalidateUserList(String(updatedMiner.user_id));
    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (cliente):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (cliente)" });
  }
};

/* ===================== Ler ===================== */
export const obterMinerPorId = async (req, res) => {
  const id = parseIntIdOr400(req, res);
  if (id === null) return;

  try {
    const [miner] = await sql/*sql*/`SELECT * FROM miners WHERE id = ${id}`;
    if (!miner) return res.status(404).json({ error: "Mineradora não encontrada" });
    res.json(miner);
  } catch (err) {
    console.error("Erro ao buscar miner:", err);
    res.status(500).json({ error: "Erro ao buscar mineradora" });
  }
};

/**
 * Listar miners por utilizador com ETag, 304 e headers de cache.
 * (O pré-cache middleware já tenta servir sem tocar aqui quando possível.)
 */
export const listarMinersPorUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const miners = await sql/*sql*/`
      SELECT * FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC;
    `;

    const { etag } = setCachedList(String(userId), miners);

    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=60");
    res.setHeader("Vary", "Authorization, X-User-Email");
    res.json(miners);
  } catch (err) {
    console.error("Erro ao listar miners:", err);
    res.status(500).json({ error: "Erro ao buscar miners" });
  }
};


