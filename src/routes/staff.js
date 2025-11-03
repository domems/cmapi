// src/routes/staff.js
import { Router } from "express";
import {
  ping,
  statsMiners,
  currentSummary,
  listarFaturasGlobais,
  notificationsUnreadCount,
  listarMinersGlobais,
  obterStatusBatch,
  obterStatusPorId,
  listarMinerStateEvents,
} from "../controllers/staffController.js";

import {
  listStaffUsers,
  lockUser,
  unlockUser,
  makeStaff,
  revokeStaff,
} from "../controllers/staffUsersController.js";

const router = Router();

// Health
router.get("/ping", ping);

// KPIs globais
router.get("/stats/miners", statsMiners);

// Resumo mês corrente (kWh, horas, subtotal)
router.get("/invoices/current/summary", currentSummary);

// Lista global de faturas (+ ?includeCurrent=1)
router.get("/invoices", listarFaturasGlobais);

// Notificações por ler (global)
router.get("/notifications/unread_count", notificationsUnreadCount);

// Miners globais (com ETag, paginação e ?coin=BTC)
router.get("/miners", listarMinersGlobais);

// Status helpers (batch e por ID)
router.get("/miners-status", obterStatusBatch);
router.get("/miners/:id/status", obterStatusPorId);

router.get("/miner-state-events", listarMinerStateEvents);

// 👇 NOVO: gestão de utilizadores
router.get("/users", listStaffUsers);
router.post("/users/:id/lock", lockUser);
router.post("/users/:id/unlock", unlockUser);
router.post("/users/:id/make-staff", makeStaff);
router.post("/users/:id/revoke-staff", revokeStaff);

export default router;
