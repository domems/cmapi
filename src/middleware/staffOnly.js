// src/middleware/staffOnly.js
import { getClerkUserById } from "../services/clerkUserService.js";

/** Extrai a role do utilizador com prioridade aos claims do JWT. */
async function resolveRole(req) {
  const claims = req.auth?.sessionClaims || {};
  const pm = claims.publicMetadata || claims.public_metadata || {};
  const roleFromClaims =
    pm.role ||
    (Array.isArray(pm.roles) && pm.roles[0]) ||
    req.auth?.user?.publicMetadata?.role ||
    req.auth?.user?.public_metadata?.role ||
    null;

  if (roleFromClaims) return String(roleFromClaims).toLowerCase();

  // fallback raro: Clerk API
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    const user = await getClerkUserById(uid);
    const pub = user?.public_metadata || user?.publicMetadata || {};
    const priv = user?.private_metadata || user?.privateMetadata || {};
    const role =
      pub.role ||
      (Array.isArray(pub.roles) && pub.roles[0]) ||
      priv.role ||
      (Array.isArray(priv.roles) && priv.roles[0]) ||
      null;
    return role ? String(role).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** staffOnly: permite role "staff". 
 *  staffOrAdmin: permite "staff" e "admin" (útil para debugging).
 */
export function staffOnly() {
  return async function (req, res, next) {
    try {
      if (!req.auth?.userId) return res.status(401).json({ error: "Auth necessária" });
      const role = await resolveRole(req);
      if (role !== "staff") return res.status(403).json({ error: "Acesso restrito a staff." });
      req.userRole = role;
      next();
    } catch (err) {
      req.log?.error({ err }, "staffOnly failure");
      res.status(500).json({ error: "Falha na verificação de permissões." });
    }
  };
}

export function staffOrAdmin() {
  return async function (req, res, next) {
    try {
      if (!req.auth?.userId) return res.status(401).json({ error: "Auth necessária" });
      const role = await resolveRole(req);
      if (role !== "staff" && role !== "admin") {
        return res.status(403).json({ error: "Acesso restrito a staff/admin." });
      }
      req.userRole = role;
      next();
    } catch (err) {
      req.log?.error({ err }, "staffOrAdmin failure");
      res.status(500).json({ error: "Falha na verificação de permissões." });
    }
  };
}
