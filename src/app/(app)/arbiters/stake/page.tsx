"use client";

/**
 * /arbiters/stake — the arbiter staking cockpit.
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

export default function ArbiterStakePage() {
  return (
    <RoleGate>
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href="/arbiters"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-faint transition-colors hover:text-dim"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Arbiter registry
        </Link>
        <h1 className="display text-[32px] leading-[1.05] md:text-[38px]">Your stake.</h1>
        <p className="max-w-[62ch] text-sm leading-relaxed text-dim">
          Bond ETH collateral to arbitrate. Every number here is read live from the registry — your stake is locked
          while you serve, can be slashed for misbehaviour, and releases only after the unstake cooldown.
        </p>
      </div>

      <ArbiterStakeHub />
    </div>
    </RoleGate>
  );
}
