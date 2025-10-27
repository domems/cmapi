import express from "express";
import {
  listarMinersPorUser,
  atualizarStatusMiner,
  atualizarMinerComoCliente,
  atualizarMinerComoAdmin,
  apagarMiner,
  obterMinerPorId,
  criarMiner,
} from "../controllers/minersController.js";

const router = express.Router();

/**
 * Ordem importa.
 * Rotas específicas primeiro; listagem por utilizador por último.
 */

// criar
router.post("/", criarMiner);

// atualizar como admin (todos os campos permitidos)
router.put("/admin/:id", atualizarMinerComoAdmin);

// atualizar como cliente (apenas campos do cliente)
router.put("/cliente/:id", atualizarMinerComoCliente);

// atualizar status explícito
router.put("/:id/status", atualizarStatusMiner);

// ler por id
router.get("/:id", obterMinerPorId);

// apagar
router.delete("/:id", apagarMiner);

// LISTAR por utilizador (não colide com /:id)
router.get("/user/:userId", listarMinersPorUser);

export default router;
