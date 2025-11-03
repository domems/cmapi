// routes/auth.js
import { Router } from "express";
import { clerkClient, requireAuth } from "@clerk/express";

const router = Router();

/* ========= helpers ========= */
function parseList(envName) {
  return String(process.env[envName] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
const ADMIN_WL = parseList("ADMIN_WHITELIST"); // "boss@x.com,owner@y.com"
const STAFF_WL = parseList("STAFF_WHITELIST"); // "tech@x.com,ops@y.com"
const STAFF_DOMAIN = String(process.env.STAFF_DOMAIN || "cryptominers.pt").toLowerCase(); // dominio que consideras staff

function primaryEmailOf(user) {
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress;
  return (primary || user.emailAddresses[0]?.emailAddress || "").toLowerCase();
}
function hasAdminWhitelist(email) {
  return !!email && ADMIN_WL.includes(email);
}
function hasStaffWhitelist(email) {
  return !!email && STAFF_WL.includes(email);
}
function inCompanyDomain(email) {
  return !!email && STAFF_DOMAIN && email.endsWith(`@${STAFF_DOMAIN}`);
}
function normalizeRole(v) {
  const r = String(v || "").toLowerCase();
  return r === "admin" || r === "staff" || r === "user" ? r : null;
}
function maxRole(a, b) {
  // prioridade: admin > staff > user
  const rank = { admin: 3, staff: 2, user: 1 };
  const na = normalizeRole(a) || "user";
  const nb = normalizeRole(b) || "user";
  return rank[na] >= rank[nb] ? na : nb;
}

/**
 * Bootstrap de role:
 * - nunca faz downgrade (se já és admin, ficas admin; se és staff, não cais para user)
 * - fontes: whitelist admin > whitelist staff > domínio empresa > orgs Clerk > metadata atual > default user
 * - grava em publicMetadata.role se houver mudança
 */
router.post("/bootstrap", requireAuth(), async (req, res) => {
  try {
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);

    const email = primaryEmailOf(user);
    const current = normalizeRole(user.publicMetadata?.role) || "user";

    // 1) whitelists
    let decided = "user";
    let source = "default";

    if (hasAdminWhitelist(email)) {
      decided = "admin"; source = "admin_whitelist";
    } else if (hasStaffWhitelist(email)) {
      decided = "staff"; source = "staff_whitelist";
    } else if (inCompanyDomain(email)) {
      decided = "staff"; source = "staff_domain";
    } else {
      // 2) Clerk orgs (se usares Organizations)
      const orgMemberships = Array.isArray(user.organizationMemberships) ? user.organizationMemberships : [];
      const hasOrgAdmin = orgMemberships.some((m) =>
        ["admin", "owner"].includes(String(m.role).toLowerCase())
      );
      const hasOrgStaff = orgMemberships.some((m) =>
        ["staff", "manager", "support"].includes(String(m.role).toLowerCase())
      );
      if (hasOrgAdmin) { decided = "admin"; source = "org_admin"; }
      else if (hasOrgStaff) { decided = "staff"; source = "org_staff"; }
      else {
        // 3) Public metadata já definida
        if (current === "admin") { decided = "admin"; source = "metadata_admin"; }
        else if (current === "staff") { decided = "staff"; source = "metadata_staff"; }
      }
    }

    // nunca fazer downgrade
    const finalRole = maxRole(current, decided);
    const changed = finalRole !== current;

    if (changed) {
      await clerkClient.users.updateUserMetadata(userId, {
        publicMetadata: { ...(user.publicMetadata || {}), role: finalRole },
      });
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      role: finalRole,          // "admin" | "staff" | "user"
      changed,                  // se gravou metadata agora
      source,                   // de onde veio a decisão (debug)
      email,                    // útil p/ logs
    });
  } catch (err) {
    console.error("[auth/bootstrap] error:", err);
    return res.status(500).json({ error: "failed_to_bootstrap_role" });
  }
});

export default router;
