"use client";

import type { ArbiterView, PublicUser, UserRole } from "@/lib/types";
import { requiredRolesForPathStrict } from "@/lib/role-routes";

export const ROLES: { id: UserRole; title: string; blurb: string; kyc: string }[] = [
  { id: "client", title: "Client", blurb: "Post jobs, fund escrow, approve work", kyc: "Light check — name + country, instant" },
  { id: "freelancer", title: "Freelancer", blurb: "Propose, ship milestones, get paid", kyc: "Standard — ID type + number" },
  { id: "arbiter", title: "Arbiter", blurb: "Resolve disputes, earn fees on stake", kyc: "Enhanced — ID + liveness + tiered stake" },
];

export const TIER_NAMES = ["Unstaked", "Bronze", "Silver", "Gold"] as const;

/** Human label for a seat — reuses ROLES so copy lives in exactly one place. */
export function roleLabel(role: UserRole): string {
  return ROLES.find((r) => r.id === role)?.title ?? role;
}

/** The four fields the profile form edits — all of them, for every seat. */
export type ProfileField = "name" | "links" | "skills" | "bio";

/**
 * Seat-shaped labels and field order for the profile form. All four fields stay
 * present for every seat — only the wording and the lead position change,
 * because the card renders all four. Hiding a field here while the card shows
 * it (or vice versa) is the bug this table exists to prevent.
 *
 * The same `skills` column carries a different thing per seat: what you can do
 * (freelancer), what you hire for (client), what you can rule on (arbiter).
 */
export const PROFILE_FORM: Record<UserRole, {
  name: string; links: string; skills: string; bio: string;
  order: readonly ProfileField[];
}> = {
  client: {
    name: "Name or company",
    links: "Links",
    skills: "Focus areas",
    bio: "What you hire for",
    order: ["name", "links", "skills", "bio"],
  },
  freelancer: {
    name: "Display name",
    links: "Portfolio links",
    skills: "Skills",
    bio: "Bio",
    order: ["name", "skills", "links", "bio"],
  },
  arbiter: {
    name: "Display name",
    links: "Credentials",
    skills: "Dispute domains you rule on",
    bio: "Professional background",
    order: ["name", "skills", "links", "bio"],
  },
};

/**
 * An arbiter's current availability, mirroring the registry:
 *   locked    → score below the withdrawal floor: benched + stake locked
 *   unstaking → requestUnstake called: benched from selection
 *   eligible  → drawable for new disputes now (stake ≥ min + duration met)
 *   understake→ stake below min: top up before the duration clock matters
 *   staked    → registered but the min-stake-duration clock is still running
 *
 * Single source of truth: the roster and the profile card must never invent two
 * vocabularies for the same on-chain state.
 */
export function arbiterStanding(a: ArbiterView, minStakeWei: string): { label: string; color: string } {
  if (a.locked) return { label: "locked", color: "var(--color-state-disputed)" };
  if (a.unstakeRequested) return { label: "unstaking", color: "var(--color-state-pending)" };
  if (a.eligible) return { label: "eligible", color: "var(--color-state-released)" };
  try {
    if (BigInt(a.stakeWei || "0") < BigInt(minStakeWei || "0")) return { label: "understake", color: "var(--color-state-disputed)" };
  } catch { /* malformed wei → fall through to staked */ }
  return { label: "staked", color: "var(--color-state-submitted)" };
}

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
