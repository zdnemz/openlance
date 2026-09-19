"use client";

/**
 * /arbiters — the trust registry as a ranked ledger: hairline rows, ghost
 * rank numerals, right-aligned trust. No card grid — a registry reads as
 * a table of record, not a wall of identical boxes.
 *
 * Every status shown here is derived from the on-chain Registry rules:
 * eligible (drawable) · unstaking (benched) · locked (score < floor) — see
 * contracts/contracts/ArbiterRegistry.sol isEligible/isLocked.
 */
import { useArbiters } from "@/lib/queries";
import { AddressAvatar, Skeleton, EmptyState, press } from "@/components/design";
import { ArbiterStakePanel } from "@/components/arbiter-stake-panel";
import { shortAddress, dateLabel, formatEth } from "@/lib/format";
import { useRuntime } from "@/lib/runtime";
import Link from "next/link";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import type { ArbiterView } from "@/lib/types";

/**
 * The arbiter's standing, mirroring the registry:
 *   locked   → score below the withdrawal floor: benched + stake locked
 *   unstaking→ requestUnstake called: benched from selection
 *   eligible → drawable for new disputes now
 *   staked   → registered but the min-stake-duration clock is still running
 */
function standing(a: ArbiterView): { label: string; color: string } {
  if (a.locked) return { label: "locked", color: "var(--color-state-disputed)" };
  if (a.unstakeRequested) return { label: "unstaking", color: "var(--color-state-pending)" };
  if (a.eligible) return { label: "eligible", color: "var(--color-state-released)" };
  return { label: "staked", color: "var(--color-state-submitted)" };
}

export default function ArbitersPage() {
  const { data: arbiters, isLoading } = useArbiters();
  const minStakeWei = useRuntime((s) => s.minStakeWei);
  const minScore = useRuntime((s) => s.minScoreToWithdraw);
  const registered = (arbiters ?? []).filter((a) => a.registered);
  // ranked by trust, then by SLA discipline — ties keep registration order
  const ranked = [...registered].sort((a, b) => b.trustScore - a.trustScore || b.resolutionsWithinSla - a.resolutionsWithinSla);
  const eligibleCount = registered.filter((a) => a.eligible).length;

  return (
    <div className="space-y-9">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-[62ch]">
          <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">Arbiters stake their name.</h1>
          <p className="mt-3 text-sm leading-relaxed text-dim">
            Arbiters bond ETH collateral and hold a soulbound badge (ERC-5194). Trust score runs{" "}
            <span className="num text-foreground">0–100</span>: you start at 100, gain{" "}
            <span className="num text-state-released">+5</span> for a majority vote, and lose{" "}
            <span className="num text-state-disputed">−10</span> minority,{" "}
            <span className="num text-state-disputed">−15</span> missed deadline,{" "}
            <span className="num text-state-disputed">−25</span> overturned. Below a score of{" "}
            <span className="num text-foreground">{minScore}</span> the stake locks and you drop out of selection;
            hit <span className="num text-foreground">0</span> and the whole stake is slashed to the treasury.
          </p>
        </div>
        {registered.length > 0 && (
          <div className="num pb-1.5 text-right text-[12px] leading-relaxed text-faint">
            {registered.length} registered
            <br />
            <span className="text-state-released">{eligibleCount}</span> eligible for selection
          </div>
        )}
      </div>

      <ArbiterStakePanel />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : !registered.length ? (
        <EmptyState
          icon={<Scales className="h-5 w-5" />}
          title="No registered arbiters yet"
          body="Be the first — stake collateral above to join the pool. New arbiters start at trust score 100."
        />
      ) : (
        <ol className="divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
          {ranked.map((a, i) => {
            const st = standing(a);
            const belowMinStake = BigInt(a.stakeWei || "0") < BigInt(minStakeWei || "0");
            return (
              <li key={a.address}>
                <Link
                  href={`/profile/${a.address}`}
                  className={`group relative flex flex-col gap-4 bg-white/[0.012] px-6 py-6 transition-colors hover:bg-white/[0.035] md:flex-row md:items-center ${press}`}
                >
                  {i === 0 && <span aria-hidden className="absolute inset-y-0 left-0 w-[2.5px] bg-rose-bright" />}
                  {/* rank */}
                  <span
                    aria-hidden
                    className={`num w-10 shrink-0 select-none text-[30px] font-semibold leading-none tracking-tighter ${
                      i === 0 ? "text-rose-bright/60" : "ghost-num"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {/* identity */}
                  <span className="flex min-w-0 flex-1 items-center gap-3.5">
                    <AddressAvatar address={a.address} size={44} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[15.5px] font-medium transition-colors group-hover:text-rose-bright">
                          {a.profile?.displayName ?? shortAddress(a.address)}
                        </span>
                        <SealCheck weight="fill" className="h-4 w-4 shrink-0 text-rose-bright" />
                        <span
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                          style={{
                            color: st.color,
                            borderColor: `color-mix(in oklab, ${st.color} 32%, transparent)`,
                            background: `color-mix(in oklab, ${st.color} 9%, transparent)`,
                          }}
                        >
                          {st.label}
                        </span>
                      </span>
                      <span className="num mt-0.5 block text-[12px] text-faint">
                        {a.registeredAt ? `registered ${dateLabel(a.registeredAt)}` : "registered"} · badge {a.sbtTokenId ? `#${a.sbtTokenId}` : "pending"}
                      </span>
                    </span>
                  </span>
                  {/* record — hairline columns, left-aligned */}
                  <span className="flex items-center gap-0 divide-x divide-white/[0.07] md:gap-6">
                    <span className="pr-5 text-left md:pr-6">
                      <span className="num block text-lg font-medium leading-none">{a.resolutions}</span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">resolved</span>
                    </span>
                    <span className="px-5 text-left md:px-6">
                      <span className="num block text-lg font-medium leading-none text-state-released">{a.resolutionsWithinSla}</span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">within SLA</span>
                    </span>
                    <span className="px-5 text-left md:px-6">
                      <span className={`num block text-lg font-medium leading-none ${a.resolutionsLate > 0 ? "text-state-disputed" : "text-dim"}`}>
                        {a.resolutionsLate}
                      </span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">late</span>
                    </span>
                  </span>
                  {/* stake — the skin in the game */}
                  <span className="flex items-baseline justify-between gap-2 border-t border-line pt-4 md:w-24 md:flex-col md:items-end md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <span className={`num text-lg font-medium leading-none ${belowMinStake ? "text-state-disputed" : "text-dim"}`}>
                      {formatEth(a.stakeWei)}
                    </span>
                    <span className="num text-[11px] uppercase tracking-[0.16em] text-faint">ETH staked</span>
                  </span>
                  {/* trust — the verdict, right rail */}
                  <span className="flex items-baseline justify-between gap-2 border-t border-line pt-4 md:w-24 md:flex-col md:items-end md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <span className={`num text-4xl font-medium leading-none tracking-tight ${a.trustScore > 0 ? "text-state-released" : "text-dim"}`}>
                      {a.trustScore}
                    </span>
                    <span className="num text-[11px] uppercase tracking-[0.16em] text-faint">trust</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
