"use client";

import type { PublicUser, UserRole } from "@/lib/types";
import { requiredRolesForPathStrict } from "@/lib/role-routes";

export const ROLES: { id: UserRole; title: string; blurb: string; kyc: string }[] = [
  { id: "client", title: "Client", blurb: "Post jobs, fund escrow, approve work", kyc: "Light check — name + country, instant" },
  { id: "freelancer", title: "Freelancer", blurb: "Propose, ship milestones, get paid", kyc: "Standard — ID type + number" },
  { id: "arbiter", title: "Arbiter", blurb: "Resolve disputes, earn fees on stake", kyc: "Enhanced — ID + liveness + tiered stake" },
];

export const TIER_NAMES = ["Unstaked", "Bronze", "Silver", "Gold"] as const;

/** Route → roles allowed (strict separation, proxy-enforced). Reads gated too. */
export function requiredRolesForPath(pathname: string): UserRole[] | null {
  return requiredRolesForPathStrict(pathname);
}

export function roleUpsell(pathname: string, role: UserRole | undefined): { title: string; body: string; cta: string } {
  if (pathname.startsWith("/stake") || pathname.startsWith("/arbiters"))
    return {
      title: "Arbiters only",
      body: role === "arbiter"
        ? "Your arbiter seat is ready — stake collateral to become selectable for disputes."
        : "This seat is proxy-guarded for arbiters — switch roles to stake and rule on disputes.",
      cta: "Become an arbiter",
    };
  if (pathname.startsWith("/jobs/new"))
    return {
      title: "Clients only",
      body: "Posting work is proxy-guarded for the client seat — switch roles to fund escrow and approve milestones.",
      cta: "Switch to client",
    };
  if (pathname.startsWith("/jobs"))
    return {
      title: "Clients and freelancers only",
      body: "The marketplace is proxy-guarded for client and freelancer seats — arbiters work from disputes and stake.",
      cta: "Fix my role",
    };
  return { title: "Wrong seat", body: "This page is proxy-guarded for a different seat.", cta: "Fix my role" };
}

export function needsOnboarding(user: PublicUser | null | undefined): boolean {
  if (!user) return false;
  return user.kycStatus === "none";
}
