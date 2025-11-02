// middleware/roles.js
import { getClerkUserById } from "../services/clerkUserService.js";

/** Extrai role com prioridade:
 *  1) req.auth.sessionClaims.publicMetadata.role (ou roles[])
 *  2) req.auth.user?.publicMetadata.role
 *  3) Fallback: Clerk API (1 chamada rara) → cache já existe em services
 */
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

  // fallback (evitado na via normal)
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

/** Guard parametrizável por roles permitidas. */
export function roleOnly(allowed = []) {
  // normaliza e congela
  const ALLOWED = new Set(allowed.map((r) => String(r).toLowerCase()));
  return async function roleGuard(req, res, next) {
    try {
      const uid = req.auth?.userId;
      if (!uid) return res.status(401).json({ error: "Auth necessária" });

      const role = await resolveRole(req);
      if (!role || !ALLOWED.has(role)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // anexa para downstream (logging / auditoria)
      req.userRole = role;
      return next();
    } catch (err) {
      req.log?.error({ err }, "roleOnly failure");
      return res.status(500).json({ error: "Falha na verificação de permissões." });
    }
  };
}

/** Compat: atalho para admin+staff nos endpoints “admin”. */
export const adminOrStaffOnly = roleOnly(["admin", "staff"]);
/** Só admin. */
export const adminOnly = roleOnly(["admin"]);
/** Só staff. */
export const staffOnly = roleOnly(["staff"]);
