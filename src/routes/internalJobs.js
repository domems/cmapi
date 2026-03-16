import { Router } from "express";
import { sql } from "../config/db.js";
import { detectAllOnce } from "../detectors/stateDetector.js";

const router = Router();
const DETECT_STATE_LOCK_KEY = 982451653;

function isAuthorizedCronRequest(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  const auth = String(req.headers.authorization || "").trim();
  if (!expected) return false;
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const token = auth.slice(7).trim();
  return token.length > 0 && token === expected;
}

router.get("/jobs/detect-state", async (req, res) => {
  try {
    const cronSecret = String(process.env.CRON_SECRET || "").trim();
    const mustRequireSecret =
      cronSecret.length > 0 ||
      process.env.VERCEL === "1" ||
      String(process.env.NODE_ENV || "").toLowerCase() === "production";

    if (!cronSecret && mustRequireSecret) {
      return res.status(500).json({ error: "CRON_SECRET missing in environment" });
    }
    if (mustRequireSecret && !isAuthorizedCronRequest(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const lockRows = await sql/*sql*/`
      SELECT pg_try_advisory_lock(${DETECT_STATE_LOCK_KEY}) AS locked
    `;
    const locked = Boolean(lockRows?.[0]?.locked);
    if (!locked) {
      return res.status(202).json({
        ok: true,
        skipped: true,
        reason: "detect_state_already_running",
      });
    }

    try {
      const result = await detectAllOnce();
      return res.status(200).json({
        ok: true,
        ...result,
      });
    } finally {
      await sql/*sql*/`SELECT pg_advisory_unlock(${DETECT_STATE_LOCK_KEY})`;
    }
  } catch (err) {
    req.log?.error({ err }, "internalJobs.detectState failed");
    return res.status(500).json({ error: "detect_state_failed" });
  }
});

export default router;
