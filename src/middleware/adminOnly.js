import { requireAuth } from "./requireAuth.js";
import { requireRole } from "./requireRole.js";

export default [requireAuth, requireRole("admin")];
