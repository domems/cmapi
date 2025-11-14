// NO RENDER – novo statusController.js (simples)
import fetch from "node-fetch";

const WORKER_BASE = process.env.WORKER_STATUS_BASE || "http://109.123.252.103:4000";

export async function getMinerStatus(req, res) {
  const { id } = req.params;
  const url = `${WORKER_BASE}/status/${encodeURIComponent(id)}?refresh=${req.query.refresh || ""}`;
  try {
    const r = await fetch(url);
    const data = await r.json().catch(() => null);
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("getMinerStatusProxy error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}

export async function getMinersStatusMany(req, res) {
  const ids = String(req.query.ids || "").trim();
  if (!ids) return res.status(400).json({ error: "ids vazios" });

  const url = `${WORKER_BASE}/status?ids=${encodeURIComponent(ids)}`;
  try {
    const r = await fetch(url);
    const data = await r.json().catch(() => null);
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("getMinersStatusManyProxy error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
