// Aceita qualquer combinação de roles permitidas
export function requireRole(...allowed) {
  return (req, res, next) => {
    const claims = req.auth?.sessionClaims;
    if (!claims) return res.status(401).json({ error: "Unauthenticated" });

    // Clerk mete isto em session claims (public_metadata / publicMetadata)
    const role =
      claims.public_metadata?.role ||
      claims.publicMetadata?.role ||
      null;

    if (!role) return res.status(403).json({ error: "No role" });
    if (!allowed.includes(role)) return res.status(403).json({ error: "Forbidden" });

    req.role = role;
    next();
  };
}
