import { Router } from "express";

const router = Router();

function clean(value) {
  return String(value || "").trim();
}

router.get("/support/contact", (_req, res) => {
  const email = clean(process.env.SUPPORT_EMAIL) || "support@cryptominers.pt";
  const whatsapp = clean(process.env.SUPPORT_WHATSAPP);

  res.set("Cache-Control", "no-store");
  return res.json({ email, whatsapp });
});

export default router;
