// Curto-circuito de cache ANTES do rate-limiter para GET /miners/user/:userId
import { getCachedList } from "../services/minersListCache.js";

export function preListCache() {
  return (req, res, next) => {
    const { userId } = req.params || {};
    if (!userId) return next();

    const cached = getCachedList(String(userId));
    if (!cached) return next();

    const fresh = cached.expiresAt > Date.now();
    const inm = req.headers["if-none-match"];

    if (inm && inm === cached.etag && fresh) {
      res.status(304).end();
      return;
    }

    if (fresh) {
      res.setHeader("ETag", cached.etag);
      res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=60");
      res.setHeader("Vary", "Authorization, X-User-Email");
      res.json(cached.bodyJson);
      return;
    }

    next();
  };
}
