// routes/storeMinersRoutes.js
import { Router } from "express";
import { requireAuth } from "@clerk/express";
import { adminOrStaffOnly } from "../middleware/roles.js";
import {
  getStoreMiners,
  createStoreMiner,
  updateStoreMiner,
  deleteStoreMiner,
  assignStoreMinerToUser,
} from "../controllers/storeMinersController.js";

const router = Router();

router.get("/store-miners", requireAuth(), adminOrStaffOnly, getStoreMiners);
router.post("/store-miners", requireAuth(), adminOrStaffOnly, createStoreMiner);
router.put("/store-miners/:id", requireAuth(), adminOrStaffOnly, updateStoreMiner);
router.delete("/store-miners/:id", requireAuth(), adminOrStaffOnly, deleteStoreMiner);
router.post(
  "/store-miners/:id/assign",
  requireAuth(),
  adminOrStaffOnly,
  assignStoreMinerToUser
);

export default router;
