// NO RENDER – novo statusController.js (simples)
import fetch from "node-fetch";

const RAW_WORKER_BASE =
  process.env.WORKER_STATUS_BASE ||
  process.env.STATUS_API_BASE ||
  "";
const WORKER_BASE = String(RAW_WORKER_BASE).replace(/\/+$/, "");
const isProd = process.env.NODE_ENV === "production";

function resolveWorkerBase() {
  if (WORKER_BASE) return WORKER_BASE;
  if (!isProd) return "http://127.0.0.1:4000";
  return "";
}

async function proxyJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, data, raw: text };
  } finally {
    clearTimeout(to);
  }
}

export async function getMinerStatus(req, res) {
  const base = resolveWorkerBase();
  if (!base) {
    return res.status(503).json({ error: "worker_base_not_configured" });
  }
  const { id } = req.params;
  const url = `${base}/status/${encodeURIComponent(id)}?refresh=${req.query.refresh || ""}`;
  try {
    const out = await proxyJson(url);
    if (!out.data && out.raw) {
      return res.status(out.status).json({ error: "worker_non_json", detail: out.raw.slice(0, 220) });
    }
    return res.status(out.status).json(out.data);
  } catch (e) {
    console.error("getMinerStatusProxy error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}

export async function getMinersStatusMany(req, res) {
  const base = resolveWorkerBase();
  if (!base) {
    return res.status(503).json({ error: "worker_base_not_configured" });
  }
  const ids = String(req.query.ids || "").trim();
  if (!ids) return res.status(400).json({ error: "ids vazios" });

  const url = `${base}/status?ids=${encodeURIComponent(ids)}`;
  try {
    const out = await proxyJson(url);
    if (!out.data && out.raw) {
      return res.status(out.status).json({ error: "worker_non_json", detail: out.raw.slice(0, 220) });
    }
    return res.status(out.status).json(out.data);
  } catch (e) {
    console.error("getMinersStatusManyProxy error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
