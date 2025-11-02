import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** Limiter global sensato.
 *  Chave por userId quando autenticado, senão IP (com proxy trust).
 */
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.auth?.userId) return `uid:${req.auth.userId}`;
    return ipKeyGenerator(req);
  },
  skip: (req) => req.method === "OPTIONS" || req.method === "HEAD",
});

export default limiter;
