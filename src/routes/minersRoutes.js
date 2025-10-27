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
 * Ordem importa. Rotas específicas primeiro.
 * MUITO IMPORTANTE: /user/:userId TEM de vir ANTES de "/:id"
 */

// atualizar como cliente
router.put("/cliente/:id", atualizarMinerComoCliente);


// LISTAR por utilizador (<<< ANTES do "/:id")
router.get("/user/:userId", listarMinersPorUser);

// ler por id
router.get("/:id", obterMinerPorId);


export default router;
