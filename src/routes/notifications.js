import express from "express";
import {
  listMyNotifications,
  unreadCount,
  markMyNotificationRead,
  markAllMyNotificationsRead,
} from "../controllers/notificationsController.js";

const router = express.Router();

router.get("/me/notifications", listMyNotifications);
router.get("/me/notifications/unread_count", unreadCount);

router.post("/me/notifications/:id/read", express.json(), markMyNotificationRead);
router.post("/me/notifications/read_all", express.json(), markAllMyNotificationsRead);

export default router;
