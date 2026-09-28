"use client";

/**
 * /stake — the arbiter staking cockpit (arbiter-only, proxy-enforced).
 *
 * Left column: your live position (stake, trust meter vs. the lock floor, the
 * eligibility + exit clocks, serving/locked notices). Right column: the action
 * panel (join · top up · request/cancel unstake · withdraw). When you have not
 * staked yet, the left column becomes the contract rules and the right column
 * the join form — same layout, no dead space.
 */
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArbiterStakeHub } from "@/components/arbiter-stake-panel";
import { RoleGate } from "@/components/role-gate";
import { PageHeader } from "@/components/page-header";

export default function ArbiterStakePage() {
  return (
    <RoleGate>
    <div className="space-y-7">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-faint transition-colors hover:text-dim"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Dashboard
      </Link>
      <PageHeader
        title="Your stake."
        desc="Bond ETH collateral to arbitrate. Every number here is read live from the registry — your stake is locked while you serve, can be slashed for misbehaviour, and releases only after the unstake cooldown."
        meta={<>arbiter seat<br />proxy-guarded</>}
      />

      <ArbiterStakeHub />
    </div>
    </RoleGate>
  );
}
