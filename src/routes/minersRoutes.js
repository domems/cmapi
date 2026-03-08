import express from "express";
import {
  listarMinersPorUser,
  atualizarMinerComoCliente,
  obterMinerPorId,
  getMinerStateHistory,
} from "../controllers/minersController.js";

// src/routes/minersRoutes.js
const router = express.Router();

// 1º: histórico
router.get("/state/:id/state-history", getMinerStateHistory);
router.get("/:id/state-history", getMinerStateHistory); // compat legado

// 2º: update cliente
router.put("/cliente/:id", atualizarMinerComoCliente);

// 3º: listar por user
router.get("/user/:userId", listarMinersPorUser);

// 4º: obter por id
router.get("/:id", obterMinerPorId);

export default router;
