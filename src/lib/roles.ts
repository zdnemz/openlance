"use client";

import type { PublicUser, UserRole } from "@/lib/types";

export const ROLES: { id: UserRole; title: string; blurb: string; kyc: string }[] = [
  { id: "client", title: "Client", blurb: "Post jobs, fund escrow, approve work", kyc: "Light check — name + country, instant" },
  { id: "freelancer", title: "Freelancer", blurb: "Propose, ship milestones, get paid", kyc: "Standard — ID type + number" },
  { id: "arbiter", title: "Arbiter", blurb: "Resolve disputes, earn fees on stake", kyc: "Enhanced — ID + liveness + tiered stake" },
];

export const TIER_NAMES = ["Unstaked", "Bronze", "Silver", "Gold"] as const;

/** Route → roles allowed to WRITE. Reads stay open; writes gate. */
export function requiredRolesForPath(pathname: string): UserRole[] | null {
  if (pathname.startsWith("/jobs/new")) return ["client"];
  if (pathname.startsWith("/arbiters/stake")) return ["arbiter"];
  return null; // open read (registry, marketplace, disputes browse)
}

export function roleUpsell(pathname: string, role: UserRole | undefined): { title: string; body: string; cta: string } {
  if (pathname.startsWith("/arbiters"))
    return {
      title: "Arbiters only",
      body: role === "arbiter"
        ? "Your arbiter seat is ready — stake collateral to become selectable for disputes."
        : "Switch to the arbiter seat, verify enhanced KYC, then stake to rule on disputes.",
      cta: "Become an arbiter",
    };
  if (pathname.startsWith("/jobs/new"))
    return {
      title: "Clients only",
      body: "Posting work needs the client seat — switch roles to fund escrow and approve milestones.",
      cta: "Switch to client",
    };
  return { title: "Wrong seat", body: "This action needs a different role.", cta: "Fix my role" };
}

export function needsOnboarding(user: PublicUser | null | undefined): boolean {
  if (!user) return false;
  return user.kycStatus === "none";
}
