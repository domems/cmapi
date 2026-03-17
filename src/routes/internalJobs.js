import { Router } from "express";
import { sql } from "../config/db.js";
import { detectAllOnce } from "../detectors/stateDetector.js";
import { runDeliverPushOnce } from "../jobs/deliverPush.js";
import { runInvoiceLate5dOnce } from "../jobs/invoiceLate5d.js";
import { runMonthlyCloseNow } from "../jobs/monthlyClose.js";

const router = Router();
const DETECT_STATE_LOCK_KEY = 982451653;
const DELIVER_PUSH_LOCK_KEY = 982451657;
const INVOICE_LATE_5D_LOCK_KEY = 982451659;
const MONTHLY_CLOSE_LOCK_KEY = 982451663;

function isAuthorizedCronRequest(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  const auth = String(req.headers.authorization || "").trim();
  if (!expected) return false;
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const token = auth.slice(7).trim();
  return token.length > 0 && token === expected;
}

function mustRequireSecret() {
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  return (
    cronSecret.length > 0 ||
    process.env.VERCEL === "1" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  );
}

function authorizeInternalJob(req, res) {
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const requireSecret = mustRequireSecret();

  if (!cronSecret && requireSecret) {
    res.status(500).json({ error: "CRON_SECRET missing in environment" });
    return false;
  }
  if (requireSecret && !isAuthorizedCronRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function withPgAdvisoryLock(lockKey, onLocked) {
  const lockRows = await sql/*sql*/`
    SELECT pg_try_advisory_lock(${lockKey}) AS locked
  `;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return { locked: false };

  try {
    const data = await onLocked();
    return { locked: true, data };
  } finally {
    await sql/*sql*/`SELECT pg_advisory_unlock(${lockKey})`;
  }
}

router.get("/jobs/detect-state", async (req, res) => {
  if (!authorizeInternalJob(req, res)) return;

  try {
    const r = await withPgAdvisoryLock(DETECT_STATE_LOCK_KEY, async () => detectAllOnce());
    if (!r.locked) {
      return res.status(202).json({ ok: true, skipped: true, reason: "detect_state_already_running" });
    }
    return res.status(200).json({ ok: true, ...r.data });
  } catch (err) {
    req.log?.error({ err }, "internalJobs.detectState failed");
    return res.status(500).json({ error: "detect_state_failed" });
  }
});

router.get("/jobs/deliver-push", async (req, res) => {
  if (!authorizeInternalJob(req, res)) return;

  try {
    const r = await withPgAdvisoryLock(DELIVER_PUSH_LOCK_KEY, async () => runDeliverPushOnce());
    if (!r.locked) {
      return res.status(202).json({ ok: true, skipped: true, reason: "deliver_push_already_running" });
    }
    return res.status(200).json({ ok: true, ...r.data });
  } catch (err) {
    req.log?.error({ err }, "internalJobs.deliverPush failed");
    return res.status(500).json({ error: "deliver_push_failed" });
  }
});

router.get("/jobs/invoice-late5d", async (req, res) => {
  if (!authorizeInternalJob(req, res)) return;

  try {
    const r = await withPgAdvisoryLock(INVOICE_LATE_5D_LOCK_KEY, async () => runInvoiceLate5dOnce());
    if (!r.locked) {
      return res.status(202).json({ ok: true, skipped: true, reason: "invoice_late5d_already_running" });
    }
    return res.status(200).json({ ok: true, ...r.data });
  } catch (err) {
    req.log?.error({ err }, "internalJobs.invoiceLate5d failed");
    return res.status(500).json({ error: "invoice_late5d_failed" });
  }
});

router.get("/jobs/monthly-close", async (req, res) => {
  if (!authorizeInternalJob(req, res)) return;

  try {
    const r = await withPgAdvisoryLock(MONTHLY_CLOSE_LOCK_KEY, async () => {
      await runMonthlyCloseNow();
      return { executed: true };
    });
    if (!r.locked) {
      return res.status(202).json({ ok: true, skipped: true, reason: "monthly_close_already_running" });
    }
    return res.status(200).json({ ok: true, ...r.data });
  } catch (err) {
    req.log?.error({ err }, "internalJobs.monthlyClose failed");
    return res.status(500).json({ error: "monthly_close_failed" });
  }
});

export default router;
