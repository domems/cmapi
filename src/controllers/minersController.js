import { sql } from "../config/db.js";
import {
  setCachedList,
  getCachedList,
  invalidateUserList,
} from "../services/minersListCache.js";

/* ===================== Utils ===================== */

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

/* ===================== Criar ===================== */
export const criarMiner = async (req, res) => {
  const {
    user_id,
    nome,
    modelo,
    hash_rate,
    preco_kw,
    consumo_kw_hora,
    status,
    worker_name,
    api_key,
    secret_key,
    coin,
    pool,
    locked, // default true
  } = req.body || {};

  try {
    const nomeClean = String(nome || "").trim();
    if (!user_id || !nomeClean) {
      return res.status(400).json({ error: "Campos obrigatórios em falta: user_id e nome." });
    }

    let hashRateNum = null, precoKwNum = null, consumoNum = null;
    try {
      hashRateNum = normalizeDecimal(hash_rate);
      precoKwNum  = normalizeDecimal(preco_kw);
      consumoNum  = normalizeDecimal(consumo_kw_hora);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const lockedVal = (typeof locked === "boolean") ? locked : true;
    const statusVal = status ? String(status).toLowerCase() : "offline";

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
        ${statusVal},
        ${worker_name ? String(worker_name).trim() : null},
        ${api_key ? String(api_key).trim() : null},
        ${secret_key ? String(secret_key).trim() : null},
        ${coin ? String(coin).trim() : null},
        ${pool ? String(pool).trim() : null},
        ${lockedVal}
      )
      RETURNING *;
    `;

    invalidateUserList(String(user_id));
    res.status(201).json(novoMiner);
  } catch (err) {
    console.error("Erro ao criar miner:", err);
    res.status(500).json({ error: "Erro ao criar miner" });
  }
};

/* ===================== Atualizar (Admin) ===================== */
export const atualizarMinerComoAdmin = async (req, res) => {
  const { id } = req.params;
  const {
    user_id,
    nome, modelo, hash_rate, preco_kw, consumo_kw_hora, status,
    worker_name, api_key, secret_key, coin, pool, locked
  } = req.body || {};

  try {
    let hashRateNum = undefined, precoKwNum = undefined, consumoNum = undefined;
    try {
      if (hash_rate !== undefined) hashRateNum = normalizeDecimal(hash_rate);
      if (preco_kw  !== undefined) precoKwNum  = normalizeDecimal(preco_kw);
      if (consumo_kw_hora !== undefined) consumoNum = normalizeDecimal(consumo_kw_hora);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }

    const [updated] = await sql`
      UPDATE miners
      SET
        user_id           = COALESCE(${user_id ?? null}, user_id),
        nome              = COALESCE(${nome !== undefined ? String(nome).trim() : null}, nome),
        modelo            = COALESCE(${modelo !== undefined ? String(modelo).trim() : null}, modelo),
        hash_rate         = COALESCE(${hashRateNum ?? null}, hash_rate),
        preco_kw          = COALESCE(${precoKwNum ?? null}, preco_kw),
        consumo_kw_hora   = COALESCE(${consumoNum ?? null}, consumo_kw_hora),
        status            = COALESCE(${status !== undefined ? String(status).toLowerCase() : null}, status),
        worker_name       = COALESCE(${worker_name ?? null}, worker_name),
        api_key           = COALESCE(${api_key ?? null}, api_key),
        secret_key        = COALESCE(${secret_key ?? null}, secret_key),
        coin              = COALESCE(${coin ?? null}, coin),
        pool              = COALESCE(${pool ?? null}, pool),
        locked            = COALESCE(${locked ?? null}, locked),
        updated_at        = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;

    if (!updated) return res.status(404).json({ error: "Miner não encontrada." });

    // invalida cache do dono (antigo e novo user, se mudou)
    const targetUserId = updated.user_id ?? user_id;
    if (targetUserId) invalidateUserList(String(targetUserId));

    res.json(updated);
  } catch (err) {
    console.error("Erro ao atualizar miner (admin):", err);
    res.status(500).json({ error: "Erro ao atualizar miner (admin)" });
  }
};

/* ========== Atualização por cliente (campos do cliente) ========== */
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

    if (String(finalPool || "").toLowerCase() === "binance" && (!finalApi || !finalSec)) {
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

    if (updatedMiner?.user_id) invalidateUserList(String(updatedMiner.user_id));
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
 * Listar miners por utilizador com ETag, 304 e headers de cache.
 * (O pré-cache middleware já tenta servir sem tocar aqui quando possível.)
 */
export const listarMinersPorUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const miners = await sql`
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

/* ===================== Status & Delete ===================== */
export const atualizarStatusMiner = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  try {
    if (status !== undefined) {
      const clean = String(status).toLowerCase();
      if (!["online", "offline", "maintenance"].includes(clean)) {
        return res.status(400).json({ error: "Status inválido (use 'online' | 'offline' | 'maintenance')." });
      }
    }
    const [updatedMiner] = await sql`
      UPDATE miners
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *;
    `;

    if (updatedMiner?.user_id) invalidateUserList(String(updatedMiner.user_id));
    res.json(updatedMiner);
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
    res.status(500).json({ error: "Erro ao atualizar status do miner" });
  }
};

export const apagarMiner = async (req, res) => {
  const { id } = req.params;
  try {
    const [curr] = await sql`SELECT user_id FROM miners WHERE id = ${id} LIMIT 1`;
    await sql`DELETE FROM miners WHERE id = ${id}`;
    if (curr?.user_id) invalidateUserList(String(curr.user_id));
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao apagar miner:", err);
    res.status(500).json({ error: "Erro ao apagar miner" });
  }
};
