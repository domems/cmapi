import express from "express";
import {
  listarMinersPorUser,
  atualizarMinerComoCliente,
  obterMinerPorId,
  getMinerStateHistory,
} from "../controllers/minersController.js";

const router = express.Router();

/**
 * Ordem importa. Rotas específicas primeiro.
 * MUITO IMPORTANTE: /user/:userId TEM de vir ANTES de "/:id"
 */

// atualizar como cliente
router.put("/cliente/:id", atualizarMinerComoCliente);


// LISTAR por utilizador (<<< ANTES do "/:id")
router.get("/user/:userId", listarMinersPorUser);

// ler por id
router.get("/:id", obterMinerPorId);

router.get("/miners/:id/state-history", getMinerStateHistory);

export default router;
