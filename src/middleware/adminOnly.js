import { isEmailAdminByClerk, getClerkUserById } from "../services/clerkUserService.js";

/** Permite admin via:
 *  - header x-user-email (frontend já envia) OU
 *  - userId da Clerk (req.auth.userId) → vai buscar email e valida role
 */
export async function adminOnly(req, res, next) {
  try {
    const headerEmail = String(req.headers["x-user-email"] || "").trim().toLowerCase();
    if (headerEmail) {
      const ok = await isEmailAdminByClerk(headerEmail);
      if (ok) return next();
    }

    const userId = req.auth?.userId;
    if (userId) {
      const user = await getClerkUserById(userId).catch(() => null);
      const email =
        user?.primary_email_address?.email_address ||
        user?.email_addresses?.[0]?.email_address ||
        null;
      if (email) {
        const ok = await isEmailAdminByClerk(email);
        if (ok) return next();
      }
    }

    return res.status(403).json({ error: "Acesso restrito a administradores." });
  } catch (err) {
    console.error("adminOnly:", err);
    return res.status(500).json({ error: "Falha na verificação de permissões." });
  }
}
