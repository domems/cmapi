// routes/statusRoutes.js
import express from "express";
import { getMinerStatus, getMinersStatusMany } from "../controllers/statusController.js";

const router = express.Router();

// ✅ Batch primeiro para não colidir com /miners/:id/status
router.get("/miners-status", getMinersStatusMany);

// ✅ Single (o controller já aceita :id ou :minerId)
router.get("/miners/:id/status", getMinerStatus);
// Se quiseres manter o teu path antigo também:
router.get("/miners/:minerId/status", getMinerStatus);

export default router;
