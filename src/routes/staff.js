// src/routes/staff.js
import { Router } from "express";
import {
  ping,
  statsMiners,
  currentSummary,
  listarFaturasGlobais,
  listarMinersGlobais,
  obterStatusBatch,
  obterStatusPorId,
  listarMinerStateEvents,
  offlineSummaryByMonth,
} from "../controllers/staffController.js";
import {
  listStaffNotifications,
  unreadStaffNotificationsCount,
  ackStaffNotification,
  ackAllStaffNotifications,
} from "../controllers/staffNotificationsController.js";

import {
  listStaffUsers,
  getStaffUsersCount,
  lockUser,
  unlockUser,
  makeStaff,
  revokeStaff,
} from "../controllers/staffUsersController.js";

// ⬇️ Sub-router com endpoints /users/:userId/miners e /users/:userId/invoices
// (já inclui também POST /miners/:id/status e GET /invoices/status)
import staffMinersInvoicesRouter from "../controllers/staffMinersInvoicesController.js";

const router = Router();

/* ---------- Health ---------- */
router.get("/ping", ping);

/* ---------- KPIs globais ---------- */
router.get("/stats/miners", statsMiners);

/* ---------- Resumo mês corrente (kWh, horas, subtotal) ---------- */
router.get("/invoices/current/summary", currentSummary);

/* ---------- Lista global de faturas (+ ?includeCurrent=1) ---------- */
router.get("/invoices", listarFaturasGlobais);

/* ---------- Notificações por ler (global) ---------- */
router.get("/notifications", listStaffNotifications);
router.get("/notifications/unread_count", unreadStaffNotificationsCount);
router.post("/notifications/:id/ack", ackStaffNotification);
router.post("/notifications/ack_all", ackAllStaffNotifications);

/* ---------- Miners globais (com ETag, paginação e ?coin=BTC) ---------- */
router.get("/miners", listarMinersGlobais);

/* ---------- Status helpers (batch e por ID) ---------- */
router.get("/miners-status", obterStatusBatch);
router.get("/miners/:id/status", obterStatusPorId);

/* ---------- Timeline de eventos de estado ---------- */
router.get("/miner-state-events", listarMinerStateEvents);
router.get("/offline-summary", offlineSummaryByMonth);

/* ---------- Gestão de utilizadores (staff/admin) ---------- */
router.get("/users/count", getStaffUsersCount);
router.get("/users", listStaffUsers);
router.post("/users/:id/lock", lockUser);
router.post("/users/:id/unlock", unlockUser);
router.post("/users/:id/make-staff", makeStaff);
router.post("/users/:id/revoke-staff", revokeStaff);

/* ---------- Sub-rotas: gestão de miners e faturas por utilizador ---------- */
/*
   Fornece:
   GET  /users/:userId/miners
   POST /miners/:id/status            { status: 'online'|'offline'|'maintenance' }
   GET  /users/:userId/invoices?includeCurrent=1
   GET  /users/:userId/invoices/detail?current=1 | ?invoiceId=123 | ?year=YYYY&month=M
   POST /users/:userId/invoices/close-now
   GET  /invoices/status?invoiceId=123
*/
router.use(staffMinersInvoicesRouter);

export default router;
