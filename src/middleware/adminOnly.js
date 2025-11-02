// src/middleware/adminOnly.js
import { requireAuth } from "@clerk/express";

// Middleware composto: autentica e exige role=admin
export default [
  requireAuth(),
  (req, res, next) => {
    const claims = req.auth?.sessionClaims;
    const role =
      claims?.public_metadata?.role ??
      claims?.publicMetadata?.role ??
      null;

    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  },
];
