import { resolveEmailByUserId, isEmailAdminByClerk } from "../services/clerkUserService.js";

/** Apenas sessão + role na Clerk.
 *  ZERO confiança em headers (nada de x-user-email).
 */
export async function adminOnly(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ error: "Auth necessária" });

    const email = await resolveEmailByUserId(userId).catch(() => null);
    if (!email) return res.status(403).json({ error: "Sem e-mail associado" });

    const ok = await isEmailAdminByClerk(email);
    if (!ok) return res.status(403).json({ error: "Acesso restrito a administradores." });

    return next();
  } catch (err) {
    req.log?.error({ err }, "adminOnly failure");
    return res.status(500).json({ error: "Falha na verificação de permissões." });
  }
}
