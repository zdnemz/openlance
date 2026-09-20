/**
 * Role route matrix — single source of truth for proxy + client guards.
 *
 * Edge-safe: no node imports, no "use client". Importable from `src/proxy.ts`.
 *
 * Strict separation (confirmed intent):
 *   client:     dashboard, jobs (browse + post), projects, disputes
 *   freelancer: dashboard, jobs (browse only), projects, disputes
 *   arbiter:    dashboard, stake, disputes, projects (read context for votes)
 *
 * /dashboard is the single adaptive home for every role — the proxy redirects
 * wrong-seat hits there. API routes enforce their own auth; the proxy only
 * shapes navigation. Role cookies are UX hints stamped by verified server
 * routes (from the session JWT), never a security boundary.
 */

export type AppRole = "client" | "freelancer" | "arbiter";

/** Cookies read by the edge proxy (see src/server/lib/http.ts for writers). */
export const ONBOARDED_COOKIE = "el_onboarded";
export const ROLE_COOKIE = "el_role";

export const ROLE_HOME = "/dashboard" as const;

const SHARED_PREFIXES = [
  "/dashboard",
  "/disputes",
  "/projects",
  "/settings",
  "/profile",
  "/onboarding",
] as const;

/** Prefix allowlist per role (strict). */
const ALLOW: Record<AppRole, readonly string[]> = {
  // Post-a-job lives under /jobs/new — client-only via explicit deny below.
  client: [...SHARED_PREFIXES, "/jobs", "/admin"],
  freelancer: [...SHARED_PREFIXES, "/jobs", "/admin"],
  arbiter: [...SHARED_PREFIXES, "/stake", "/arbiters", "/admin"],
};

export function isAppRole(v: string | null | undefined): v is AppRole {
  return v === "client" || v === "freelancer" || v === "arbiter";
}

/** Proxy + RoleGate check: may `role` (or logged-out) view `pathname`? */
export function isAllowed(pathname: string, role: AppRole | null | undefined): boolean {
  const p = pathname.split("?")[0] ?? "/";
  // Landing + static + API are never role-gated here.
  if (p === "/") return true;
  if (p.startsWith("/api") || p.startsWith("/_next") || p === "/favicon.ico" || p === "/icon.svg") return true;
  // Logged-out: let the onboarded-cookie gate decide (bounces to /onboarding).
  if (!role) return true;
  // Explicit denies first (finer than prefix matching).
  if (p === "/jobs/new" || p.startsWith("/jobs/new/")) return role === "client";
  if (p === "/stake" || p.startsWith("/stake/")) return role === "arbiter";
  if (p === "/arbiters" || p.startsWith("/arbiters/")) return role === "arbiter";
  if (p === "/jobs" || p.startsWith("/jobs/")) return role === "client" || role === "freelancer";
  const prefixes = ALLOW[role];
  for (const pre of prefixes) {
    if (p === pre || p.startsWith(`${pre}/`)) return true;
  }
  // Unknown app paths: allow through (Next renders 404, not a seat leak).
  if (p.startsWith("/console") || p.startsWith("/admin")) return true;
  return false;
}

/** Write-gate helper for RoleGate copy (which seats may WRITE here). */
export function requiredRolesForPathStrict(pathname: string): AppRole[] | null {
  const p = pathname.split("?")[0] ?? "/";
  if (p === "/jobs/new" || p.startsWith("/jobs/new/")) return ["client"];
  if (p === "/stake" || p.startsWith("/stake/")) return ["arbiter"];
  if (p === "/arbiters" || p.startsWith("/arbiters/")) return ["arbiter"];
  if (p === "/jobs" || p.startsWith("/jobs/")) return ["client", "freelancer"];
  return null;
}
