// routes/statusRoutes.js
import express from "express";
import { getMinerStatus, getMinersStatusMany } from "../controllers/statusController.js";

const router = express.Router();

// batch primeiro
router.get("/miners-status", getMinersStatusMany);

// single
router.get("/miners/:id/status", getMinerStatus);
router.get("/miners/:minerId/status", getMinerStatus);

export default router;
