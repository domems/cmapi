// src/controllers/minersController.js
import { sql } from "../config/db.js";
import crypto from "crypto";

/* ===================== Helpers ===================== */

function parseBool(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["1","true","t","yes","y","on"].includes(s)) return true;
  if (["0","false","f","no","n","off"].includes(s)) return false;
  return undefined;
}

/** "0,08" -> 0.08 ; "", null, undefined -> null ; lança em caso inválido */
function normalizeDecimal(input) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Valor numérico inválido: "${input}"`);
    return input;
  }
  const s0 = String(input).trim().replace(/\s+/g, "");
  let s = s0;
  const hasComma = s.includes(",");
  const hasDot   = s.includes(".");
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot   = s.lastIndexOf(".");
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

/* ===================== Cache de listagem ===================== */

const listCache = new Map(); // key: userId -> { bodyJson, etag, expiresAt }
const LIST_TTL_MS = 10_000; // 10s

function makeEtag(payloadString) {
  const hash = crypto.createHash("sha1").update(payloadString).digest("base64");
  return `W/"${hash}"`; // weak ETag
}

/* ===================== Criar ===================== */

export const criarMiner = async (req, res) => {
  const {
    user_id,
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora,
    worker_name,
    api_key,
    secret_key,
    coin,
    pool,
    locked, // opcional; default = true
  } = req.body || {};

  try {
    const nomeClean = String(nome || "").trim();
    if (!user_id || !nomeClean) {
      return res.status(400).json({ error: "Campos obrigatórios em falta: user_id e nome." });
    }

    let hashRateNum = null;
    let precoKwNum = null;
    let consumoNum = null;
    try {
      hashRateNum = normalizeDecimal(hash_rate);
      precoKwNum = normalizeDecimal(preco_kw);
      consumoNum = normalizeDecimal(consumo_kw_hora);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const lockedVal = (typeof locked === "boolean") ? locked : true;

    const [novoMiner] = await sql`
      INSERT INTO miners (
        user_id, nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status,
        worker_name, api_key, secret_key, coin, pool, locked
      ) VALUES (
        ${user_id},
        ${nomeClean},
        ${modelo ? String(modelo).trim() : null},
        ${hashRateNum},
        ${precoKwNum},
        ${consumoNum},
        'offline',
        ${worker_name ? String(worker_name).trim() : null},
        ${api_key ? String(api_key).trim() : null},
        ${secret_key ? String(secret_key).trim() : null},
        ${coin ? String(coin).trim() : null},
        ${pool ? String(pool).trim() : null},
        ${lockedVal}
      )
      RETURNING *;
    `;

    // invalida cache da listagem do utilizador
    listCache.delete(String(user_id));

    res.status(201).json(novoMiner);
  } catch (err) {
    console.error("Erro ao criar miner:", err);
    res.status(500).json({ error: "Erro ao criar miner" });
  }
};

/* ========== Atualização por cliente (campos do cliente) ========== */
/* Regra: se locked=true → 423 Locked. Para Binance exige api+secret. */
export const atualizarMinerComoCliente = async (req, res) => {
  const { id } = req.params;
  const { worker_name, api_key, secret_key, coin, pool } = req.body || {};

  try {
    const [curr] = await sql`
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

    if (String(finalPool).toLowerCase() === "binance" && (!finalApi || !finalSec)) {
      return res.status(400).json({ error: "Para Binance, api_key e secret_key são obrigatórias." });
    }

    const [updatedMiner] = await sql`
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

    // invalida cache da listagem do utilizador dono
    if (updatedMiner?.user_id) listCache.delete(String(updatedMiner.user_id));

    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar miner (cliente):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (cliente)" });
  }
};

/* ===================== Ler ===================== */

export const obterMinerPorId = async (req, res) => {
  const { id } = req.params;
  try {
    const [miner] = await sql`SELECT * FROM miners WHERE id = ${id}`;
    if (!miner) return res.status(404).json({ error: "Mineradora não encontrada" });
    res.json(miner);
  } catch (err) {
    console.error("Erro ao buscar miner:", err);
    res.status(500).json({ error: "Erro ao buscar mineradora" });
  }
};

/**
 * Listar miners por utilizador, com cache 10s + ETag (304 Not Modified).
 * Alivia o DB e elimina 429 do teu frontend.
 */
export const listarMinersPorUser = async (req, res) => {
  const { userId } = req.params;
  const now = Date.now();

  try {
    const cached = listCache.get(String(userId));
    if (cached && cached.expiresAt > now) {
      const inm = req.headers["if-none-match"];
      if (inm && inm === cached.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("ETag", cached.etag);
      res.setHeader("Cache-Control", "public, max-age=10");
      res.json(cached.bodyJson);
      return;
    }

    const miners = await sql`
      SELECT * FROM miners
      WHERE user_id = ${userId}
      ORDER BY created_at DESC;
    `;

    const bodyJson = miners;
    const raw = JSON.stringify(bodyJson);
    const etag = makeEtag(raw);

    listCache.set(String(userId), { bodyJson, etag, expiresAt: now + LIST_TTL_MS });

    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=10");
    res.json(bodyJson);
  } catch (err) {
    console.error("Erro ao listar miners:", err);
    res.status(500).json({ error: "Erro ao buscar miners" });
  }
};

/* ===================== Status & Delete ===================== */

export const atualizarStatusMiner = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  try {
    if (status !== undefined) {
      const clean = String(status).toLowerCase();
      if (!["online", "offline"].includes(clean)) {
        return res.status(400).json({ error: "Status inválido (use 'online' ou 'offline')." });
      }
    }
    const [updatedMiner] = await sql`
      UPDATE miners
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;

    // invalida cache do dono
    if (updatedMiner?.user_id) listCache.delete(String(updatedMiner.user_id));

    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
    res.status(500).json({ error: "Erro ao atualizar status do miner" });
  }
};

export const apagarMiner = async (req, res) => {
  const { id } = req.params;
  try {
    // precisamos do user_id para invalidar o cache
    const [curr] = await sql`SELECT user_id FROM miners WHERE id = ${id} LIMIT 1`;
    await sql`DELETE FROM miners WHERE id = ${id}`;
    if (curr?.user_id) listCache.delete(String(curr.user_id));
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao apagar miner:", err);
    res.status(500).json({ error: "Erro ao apagar miner" });
  }
};
