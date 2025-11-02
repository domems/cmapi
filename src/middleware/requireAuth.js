import { requireAuth as clerkRequireAuth } from "@clerk/express";

// Garante 401 se não houver sessão válida (token verificado)
export const requireAuth = clerkRequireAuth();
