// src/routes/minersRoutes.js
import express from "express";
import {
  listarMinersPorUser,
  atualizarStatusMiner,
  atualizarMinerComoCliente,
  apagarMiner,
  obterMinerPorId,
} from "../controllers/minersController.js";

const router = express.Router();

/**
 * IMPORTANTE: a ordem das rotas interessa.
 * 1) Rotas específicas com :id primeiro
 * 2) A listagem por :userId NO FIM para não colidir
 */


// ler por id (antes da listagem)
router.get("/miners/:id", obterMinerPorId);

// atualizar como cliente
router.put("/cliente/:id", atualizarMinerComoCliente);

// atualizar status explícito
router.put("/:id/status", atualizarStatusMiner);

// apagar
router.delete("/:id", apagarMiner);

// LISTAR por utilizador (deixa por último!)
router.get("/:userId", listarMinersPorUser);

export default router;
