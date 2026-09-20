"use client";

/**
 * Arbiter staking surfaces.
 *
 *   ArbiterStakeSummary — the "Your stake" stat band on /arbiters: a full-width
 *                         read of the connected wallet's position that links to
 *                         the hub. Shown only when useful (staked, or a join CTA).
 *   ArbiterStakeHub     — the two-column staking cockpit on /stake:
 *                         LEFT is your position (big ETH, trust meter, clocks,
 *                         serving/locked notices), RIGHT is the action panel
 *                         (join · top-up · request/cancel unstake · withdraw).
 *
 * Every gate here mirrors a revert in ArbiterRegistry.sol, so a user never
 * signs a transaction that is guaranteed to fail:
 *
 *   registerArbiter()  requires msg.value ≥ minStake, not already registered
 *   addStake()         requires registered, value > 0
 *   requestUnstake()   reverts when: not registered · already requested · stake 0
 *                      · busy (activeDisputes > 0) · score < minScoreToWithdraw
 *                      · stake younger than unstakeCooldown (UnstakeTooEarly)
 *   cancelUnstake()    requires a pending request
 *   withdrawStake()    immediate — reverts when: not registered · not requested
 *                      · busy · score < minScoreToWithdraw
 *                      → on success it DEREGISTERS the arbiter (leaves the
 *                        roster) but the soulbound badge stays as history.
 *
 * Trust score is bounded to [0,100]; the only way it rises is a majority vote
 * (+5). It never self-recovers — a locked arbiter must win rounds to climb back.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet, useWalletHydrated } from "@/lib/wallet";
import { useArbiterStaking, type MyArbiterState } from "@/lib/register-arbiter";
import { useRuntime } from "@/lib/runtime";
import { useSession } from "@/lib/session";
import { TIER_NAMES } from "@/lib/roles";
import { formatEth } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Lock } from "@phosphor-icons/react/dist/csr/Lock";
import { LockOpen } from "@phosphor-icons/react/dist/csr/LockOpen";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Info } from "@phosphor-icons/react/dist/csr/Info";
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { cn } from "@/lib/utils";

/** Compact countdown: "3d 4h", "4h 12m", "12m", "<1m". */
function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/** Human label for the wallet-tx phase (sign → mine → index). */
const PHASE_LABEL: Record<string, string> = {
  signing: "Confirm in your wallet…",
  mining: "Transaction submitted — mining…",
  indexing: "Mined — mirroring via the indexer…",
  done: "Done",
};

type Standing = { label: string; tone: string; icon: "gavel" | "locked" | "clock" | "open" | "closed" };

/** One-line standing derived from the contract: mirrors isEligible / isLocked / _isBusy. */
function standingOf(state: MyArbiterState, minsToEligible: number, minsToWithdraw: number): Standing {
  if (state.busy) return { label: `serving ${state.activeDisputes} dispute${state.activeDisputes === 1 ? "" : "s"}`, tone: "var(--color-state-submitted)", icon: "gavel" };
  if (state.locked) return { label: `locked — score ${state.trustScore} < floor ${state.minScoreToWithdraw}`, tone: "var(--color-state-disputed)", icon: "locked" };
  if (state.unstakeRequested) {
    return { label: minsToWithdraw > 0 ? `unstaking — withdraw in ${fmtDuration(minsToWithdraw * 60)}` : "unstaking — ready to withdraw", tone: "var(--color-state-pending)", icon: "clock" };
  }
  if (state.eligible) return { label: "eligible for selection", tone: "var(--color-state-released)", icon: "open" };
  return { label: `eligibility in ${fmtDuration(minsToEligible * 60)}`, tone: "var(--color-state-submitted)", icon: "closed" };
}

function StandingIcon({ icon, className }: { icon: Standing["icon"]; className?: string }) {
  if (icon === "gavel") return <Gavel className={className} />;
  if (icon === "locked") return <ShieldWarning className={className} />;
  if (icon === "clock") return <Clock className={className} />;
  if (icon === "open") return <LockOpen className={className} />;
  return <Lock className={className} />;
}

/** A pill tinted by a CSS color token. */
function TonePill({ label, tone, icon, className }: { label: string; tone: string; icon: Standing["icon"]; className?: string }) {
  return (
    <span
      className={cn("num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px]", className)}
      style={{ color: tone, borderColor: `color-mix(in oklab, ${tone} 34%, transparent)`, background: `color-mix(in oklab, ${tone} 9%, transparent)` }}
    >
      <StandingIcon icon={icon} className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

/** Wallet connect / hydration placeholders shared by both surfaces. */
function useStakeContext() {
  const { address } = useWallet();
  const hydrated = useWalletHydrated();
  const { state, register, add, reduce, requestUnstake, cancelUnstake, withdraw, chain, refresh } = useArbiterStaking();
  const { minStakeWei, minScoreToWithdraw } = useRuntime();
  const registryKnown = useRuntime((s) => !!s.registry);
  const loadRuntime = useRuntime((s) => s.load);
  return { address, hydrated, state, register, add, reduce, requestUnstake, cancelUnstake, withdraw, chain, refresh, minStakeWei, minScoreToWithdraw, registryKnown, loadRuntime };
}

/** Safe wei parser — tolerates undefined/empty from a still-loading runtime. */
function toWei(v: string | bigint | null | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v !== "string" || v.length === 0) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** ETH string → wei, rounded to 6dp precision (matches the input UX). */
function ethToWei(v: string): bigint {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(Math.round(n * 1e6)) * 10n ** 12n;
}

/** Trust meter: 0..100 with the lock floor marked; the fill carries the status tone. */
function TrustMeter({ score, floor, tone }: { score: number; floor: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: tone }} />
      <span
        aria-hidden
        className="absolute inset-y-[-3px] w-px bg-white/40"
        style={{ left: `${Math.max(0, Math.min(100, floor))}%` }}
        title={`lock floor ${floor}`}
      />
    </div>
  );
}

/** Progress toward the next rank — floors come from the live registry reads,
 *  so a retune moves the goalpost automatically. Gold shows no bar. */
function RankProgress({ stakeWei, tier, minWei, silverWei, goldWei }: {
  stakeWei: string; tier: number; minWei: string; silverWei: string; goldWei: string;
}) {
  if (tier >= 3) {
    return (
      <div className="mt-4 flex items-baseline justify-between">
        <span className="num text-[11px] uppercase tracking-wider text-faint">rank</span>
        <span className="num text-[12.5px] font-medium text-state-released">Gold · top rank</span>
      </div>
    );
  }
  const stake = toWei(stakeWei);
  const floor = tier === 2 ? toWei(silverWei) : tier === 1 ? toWei(minWei) : 0n;
  const next = tier === 2 ? toWei(goldWei) : tier === 1 ? toWei(silverWei) : toWei(minWei);
  const nextName = TIER_NAMES[Math.min(tier + 1, 3)] ?? "Bronze";
  if (next <= 0n) return null;
  const span = next > floor ? next - floor : 1n;
  const done = stake > floor ? stake - floor : 0n;
  const pct = Math.max(0, Math.min(100, Number((done * 10000n) / span) / 100));
  const remaining = stake >= next ? 0n : next - stake;
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="num text-[11px] uppercase tracking-wider text-faint">next rank</span>
        <span className="num text-[12.5px] text-dim">
          {remaining > 0n ? <>{formatEth(remaining)} ETH to {nextName}</> : <>{nextName} reached</>}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: "var(--color-state-released)" }}
        />
      </div>
    </div>
  );
}

/* ── Summary band (for /arbiters) ──────────────────────────────────────────── */

export function ArbiterStakeSummary() {
  const { hydrated, address, state } = useStakeContext();

  if (!hydrated) {
    return <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-5 text-[13px] text-faint">Checking your wallet…</div>;
  }

  if (!address || !state?.registered) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-line bg-white/[0.012] px-6 py-5">
        <div className="flex items-center gap-3">
          <Coins className="h-5 w-5 shrink-0 text-state-split" />
          <div>
            <div className="text-[13.5px] text-dim">
              {address ? "You're not in the arbiter pool yet." : "Connect a wallet to join the arbiter pool."}
            </div>
            <div className="mt-0.5 text-[11.5px] text-faint">Stake ETH collateral to become selectable for disputes.</div>
          </div>
        </div>
        <Link
          href="/stake"
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-rose-accent px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-rose-bright"
        >
          Stake &amp; join
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  const minsToEligible = state ? Math.max(0, Math.ceil((state.eligibleAt - state.chainNow) / 60)) : 0;
  const minsToWithdraw = state ? Math.max(0, Math.ceil((state.unstakeReadyAt - state.chainNow) / 60)) : 0;
  const st = standingOf(state, minsToEligible, minsToWithdraw);

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-white/[0.012]">
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2 text-faint">
            <Coins className="h-4 w-4 text-state-split" />
            <span className="num text-[11px] uppercase tracking-[0.16em]">Your stake</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="num text-4xl font-medium leading-none tracking-tight">{formatEth(toWei(state.stakeWei))}</span>
            <span className="num text-[13px] text-faint">ETH</span>
            <span className="num ml-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-dim">
              {TIER_NAMES[state.tier ?? 0]?.toLowerCase() ?? "unstaked"}
            </span>
          </div>
        </div>
        <Link
          href="/stake"
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-rose-accent px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-rose-bright"
        >
          Manage stake
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-4 border-t border-line px-6 py-4 sm:grid-cols-3">
        <div>
          <div className="num text-[10.5px] uppercase tracking-wider text-faint">trust score</div>
          <div className={cn("num mt-1 text-lg font-medium", state.locked ? "text-state-disputed" : "text-state-released")}>
            {state.trustScore}
            <span className="ml-1 text-[11px] font-normal text-faint">/ 100</span>
          </div>
        </div>
        <div>
          <div className="num text-[10.5px] uppercase tracking-wider text-faint">active disputes</div>
          <div className={cn("num mt-1 text-lg font-medium", state.activeDisputes > 0 ? "text-state-submitted" : "text-dim")}>
            {state.activeDisputes}
            <span className="ml-1 text-[11px] font-normal text-faint">serving</span>
          </div>
        </div>
        <div className="col-span-2 flex items-end justify-start sm:col-span-1 sm:justify-end">
          <TonePill label={st.label} tone={st.tone} icon={st.icon} />
        </div>
      </div>
    </div>
  );
}

/* ── Hub (for /stake) ─────────────────────────────────────────────────────── */

export function ArbiterStakeHub() {
  const { address, hydrated, state, register, add, reduce, requestUnstake, cancelUnstake, withdraw, chain, refresh, minStakeWei, minScoreToWithdraw, registryKnown, loadRuntime } = useStakeContext();
  const kycStatus = useSession((s) => s.user?.kycStatus);
  const [stakeModalOpen, setStakeModalOpen] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [topUpInput, setTopUpInput] = useState("");
  const [reduceModalOpen, setReduceModalOpen] = useState(false);
  const [reduceInput, setReduceInput] = useState("");
  const [retrying, setRetrying] = useState(false);
  const active = chain.phase !== "idle" && chain.phase !== "done";

  const stakeWei = ethToWei(stakeInput);
  const topUpWei = ethToWei(topUpInput);
  const minStake = state?.minStakeWei ?? minStakeWei;
  const belowMin = stakeWei < toWei(minStake);
  // minStakeKnown=false means the registry reads failed: any minimum shown is
  // a guess, so Confirm stays shut instead of sending a reverting stake.
  const minKnown = state?.minStakeKnown ?? false;
  const retryReads = async () => {
    setRetrying(true);
    try {
      await loadRuntime();
    } finally {
      refresh();
      setRetrying(false);
    }
  };

  // Close the modal once the stake tx has fully settled, and reset the amount.
  useEffect(() => {
    if (stakeModalOpen && chain.phase === "done" && state?.registered) {
      setStakeModalOpen(false);
      setStakeInput("");
    }
  }, [stakeModalOpen, chain.phase, state?.registered]);

  // Same for the top-up modal: close once the add-stake tx settles.
  useEffect(() => {
    if (topUpModalOpen && chain.phase === "done") {
      setTopUpModalOpen(false);
      setTopUpInput("");
    }
  }, [topUpModalOpen, chain.phase]);

  // Same for the reduce modal: close once the reduce tx settles.
  useEffect(() => {
    if (reduceModalOpen && chain.phase === "done") {
      setReduceModalOpen(false);
      setReduceInput("");
    }
  }, [reduceModalOpen, chain.phase]);

  // Open on a clean slate: a previous action may have left phase "done",
  // which would instantly trip the closer above.
  const openTopUp = () => {
    chain.reset();
    setTopUpInput("");
    setTopUpModalOpen(true);
  };

  const openReduce = () => {
    chain.reset();
    setReduceInput("");
    setReduceModalOpen(true);
  };

  // Resulting tier for the pending top-up (mirrors Registry.tierOf).
  const tierForTotal = (total: bigint): number => {
    const min = toWei(state?.minStakeWei);
    if (min <= 0n || total < min) return 0;
    const gold = toWei(state?.tierGoldWei);
    if (gold > 0n && total >= gold) return 3;
    const silver = toWei(state?.tierSilverWei);
    if (silver > 0n && total >= silver) return 2;
    return 1;
  };
  const newTotalWei = toWei(state?.stakeWei) + topUpWei;
  const newTier = tierForTotal(newTotalWei);
  const currentTier = state?.tier ?? 0;

  // Pending partial exit, validated like the contract (reduceStake reverts
  // otherwise): positive, strictly partial, remainder above the floor.
  const reduceWei = ethToWei(reduceInput);
  const stakeTotal = toWei(state?.stakeWei);
  const minFloor = toWei(state?.minStakeWei);
  const reduceRemaining = stakeTotal - reduceWei;
  const reduceTier = tierForTotal(reduceRemaining >= 0n ? reduceRemaining : 0n);
  const reduceInvalid = reduceWei <= 0n ? "Enter an amount above 0."
    : !minKnown ? "Live registry reads unavailable — check your wallet network."
    : reduceWei >= stakeTotal ? "To exit fully, request unstake below instead."
    : reduceRemaining < minFloor ? `Must keep at least ${formatEth(minFloor)} ETH staked.` : null;

  if (!hydrated) {
    return (
      <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-6 text-[13px] text-faint">
        Checking your wallet…
      </div>
    );
  }

  if (!address) {
    return (
      <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-10 text-center">
        <Coins className="mx-auto h-7 w-7 text-state-split" />
        <p className="mt-3 text-[15px] font-medium">Connect a wallet to stake</p>
        <p className="mx-auto mt-1.5 max-w-[44ch] text-[13px] leading-relaxed text-faint">
          Arbiter identity follows the key — connect a wallet to join the pool, top up collateral, or withdraw.
        </p>
      </div>
    );
  }

  const minScore = state?.minScoreToWithdraw ?? minScoreToWithdraw ?? 0;
  const minStakeDays = state ? Math.max(1, Math.round(state.minStakeDurationSeconds / 86400)) : 0;
  const cooldownDays = state ? Math.max(0, Math.round(state.unstakeCooldownSeconds / 86400)) : 0;
  const nowSec = state?.chainNow ?? Math.floor(Date.now() / 1000);
  const minsToEligible = state ? Math.max(0, Math.ceil((state.eligibleAt - nowSec) / 60)) : 0;
  const minsToWithdraw = state ? Math.max(0, Math.ceil((state.unstakeReadyAt - nowSec) / 60)) : 0;
  const registered = Boolean(state?.registered);
  const busy = Boolean(state?.busy);
  const locked = Boolean(state?.locked);
  // Unknown dispute count (failed escrow read) blocks exits like a busy one —
  // the contract reverts requestUnstake/withdrawStake while serving.
  const exitBlocked = busy || locked || (registered && state?.busyKnown === false);
  // The cooldown gates the REQUEST (stakedAt + unstakeCooldown), derivable from
  // the selectability clock: stakedAt = eligibleAt - minStakeDuration.
  // unstakeReadyAt is already past once requested — withdrawal is immediate.
  const secsToRequestable = registered && state
    ? Math.max(0, state.eligibleAt - state.minStakeDurationSeconds + state.unstakeCooldownSeconds - nowSec)
    : 0;
  const requestLocked = registered && secsToRequestable > 0;
  const requestBlocked = exitBlocked || requestLocked;
  const st = state ? standingOf(state, minsToEligible, minsToWithdraw) : null;
  // isEligible covers stake floor + duration + score + bench; when the clock
  // has passed but stake < min the user is NOT selectable — surface top-up.
  const belowMinStake = registered && state ? toWei(state.stakeWei) < toWei(state.minStakeWei) : false;
  const selectableValue = state?.eligible
    ? "now"
    : belowMinStake
      ? `top up to ${formatEth(state?.minStakeWei ?? minStake)} ETH`
      : `${fmtDuration(minsToEligible * 60)}`;
  const selectableHint = state?.eligible || belowMinStake ? undefined : `${minStakeDays}d continuous stake`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-start">
      {/* ── LEFT: your position ─────────────────────────────────────── */}
      <div className="rounded-3xl border border-line bg-white/[0.012] p-6 lg:sticky lg:top-24">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="num text-[11px] uppercase tracking-[0.16em] text-faint">
            {registered ? "Your position" : "The rules"}
          </span>
          {registered && st && <TonePill label={st.label} tone={st.tone} icon={st.icon} />}
        </div>

        {registered && state ? (
          <>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="num text-[44px] font-medium leading-none tracking-tight">{formatEth(toWei(state.stakeWei))}</span>
              <span className="num text-[14px] text-faint">ETH staked</span>
              <span className="num ml-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-dim">
                {TIER_NAMES[state.tier ?? 0]?.toLowerCase() ?? "unstaked"}
              </span>
            </div>

            <RankProgress
              stakeWei={state.stakeWei}
              tier={state.tier ?? 0}
              minWei={state.minStakeWei}
              silverWei={state.tierSilverWei}
              goldWei={state.tierGoldWei}
            />

            <div className="mt-6">
              <div className="flex items-baseline justify-between">
                <span className="num text-[11px] uppercase tracking-wider text-faint">trust score</span>
                <span className={cn("num text-[15px] font-medium", locked ? "text-state-disputed" : "text-state-released")}>
                  {state.trustScore}
                  <span className="ml-1 text-[11px] font-normal text-faint">/ 100</span>
                </span>
              </div>
              <TrustMeter score={state.trustScore} floor={minScore} tone={locked ? "var(--color-state-disputed)" : "var(--color-state-released)"} />
              <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
                <span className="num">0 · slash</span>
                <span className="num">floor {minScore}</span>
                <span className="num">100 · max</span>
              </div>
            </div>

            <dl className="mt-6 space-y-2.5 border-t border-line pt-5 text-[12.5px]">
              <RuleRow label="Selectable after" value={selectableValue} hint={selectableHint} accent={belowMinStake} />
              <RuleRow
                label="Unstakeable after"
                value={state.unstakeRequested ? "requested" : requestLocked ? `${fmtDuration(secsToRequestable)}` : "now"}
                hint={state.unstakeRequested ? "withdraw below" : `${cooldownDays}d staked`}
                accent={state.unstakeRequested}
              />
              <RuleRow label="Collateral locked" value={locked ? "yes" : "no"} accent={locked} />
            </dl>

            {busy && (
              <div className="mt-5 flex items-start gap-2.5 rounded-2xl border border-state-submitted/30 bg-state-submitted/[0.06] px-3.5 py-3 text-[12.5px] text-dim">
                <Gavel className="mt-0.5 h-4 w-4 shrink-0 text-state-submitted" />
                <span>
                  Serving <span className="num text-foreground">{state.activeDisputes}</span> in-flight dispute
                  {state.activeDisputes === 1 ? "" : "s"}. The contract blocks <span className="num">requestUnstake</span> and{" "}
                  <span className="num">withdrawStake</span> until every round is resolved.
                </span>
              </div>
            )}
          </>
        ) : (
          <dl className="mt-5 space-y-3 text-[13px]">
            <RuleRow label="Minimum stake" value={`${formatEth(minStake)} ETH`} strong />
            <RuleRow label="Starting trust score" value="100 / 100" />
            <RuleRow label="Selectable after" value={`${minStakeDays}d continuous`} />
            <RuleRow label="Lock floor" value={`${minScore} / 100`} hint="below this the stake locks" />
            <RuleRow label="Zero score" value="full slash" hint="stake → treasury" accent />
            <RuleRow label="Unstakeable after" value={`${cooldownDays}d staked`} hint="then withdraw immediate" />
          </dl>
        )}
      </div>

      {/* ── RIGHT: action forms ───────────────────────────────────────── */}
      <div className="space-y-6">
        {kycStatus && kycStatus !== "verified" && (
          <p className="rounded-3xl border border-line bg-white/[0.012] px-6 py-4 text-[12px] leading-relaxed text-faint">
            On-chain selection needs stake only, but product standing needs enhanced KYC too — you’re <span className="num text-dim">KYC {kycStatus}</span>.{" "}
            <Link href="/onboarding" className="text-dim underline underline-offset-2 hover:text-foreground">Verify identity</Link>.
          </p>
        )}

        {!(state && state.registered) ? (
          <div className="rounded-3xl border border-line bg-white/[0.012] p-6">
            <h2 className="text-[16px] font-medium tracking-tight">Join the pool</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-faint">
              Deposit at least the minimum to mint your soulbound badge and enter the selection pool.
            </p>
            <div className="mt-5 space-y-3">
              <Button
                onClick={() => setStakeModalOpen(true)}
                className="w-full rounded-full bg-rose-accent py-2.5 text-[13px] font-medium hover:bg-rose-bright"
              >
                Stake &amp; join the pool
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Stake form: top up collateral ─────────────────────────── */}
            <div className="rounded-3xl border border-line bg-white/[0.012] p-6">
              <h2 className="text-[16px] font-medium tracking-tight">Stake</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-faint">
                Top up your collateral to climb tiers — Silver at {formatEth(state.tierSilverWei)} ETH, Gold at{" "}
                {formatEth(state.tierGoldWei)} ETH.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <Button
                  disabled={active}
                  onClick={openTopUp}
                  className="rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground disabled:opacity-50"
                  variant="ghost"
                >
                  Add more stake
                </Button>
                <Button
                  disabled={active}
                  onClick={openReduce}
                  className="rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground disabled:opacity-50"
                  variant="ghost"
                >
                  Reduce stake
                </Button>
              </div>
            </div>

            {/* ── Unstake form: request, cancel, withdraw ───────────────── */}
            <div className="rounded-3xl border border-line bg-white/[0.012] p-6">
              <h2 className="text-[16px] font-medium tracking-tight">Unstake</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-faint">
                Bench yourself from selection, then withdraw immediately — no waiting period after the request.
              </p>
              <div className="mt-5 space-y-3">
                {!state.unstakeRequested ? (
                  <Button
                    disabled={active || requestBlocked}
                    onClick={() => requestUnstake()}
                    title={
                      busy ? `You are serving ${state.activeDisputes} active dispute${state.activeDisputes === 1 ? "" : "s"}`
                        : locked ? `Locked: score ${state.trustScore} < floor ${minScore}`
                          : requestLocked ? `Stake must age ${cooldownDays}d before you can request unstake`
                            : "Request unstake — withdrawal pays out immediately"
                    }
                    className="w-full rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground disabled:opacity-50"
                    variant="ghost"
                  >
                    {busy
                      ? `Bench blocked — serving ${state.activeDisputes} dispute${state.activeDisputes === 1 ? "" : "s"}`
                      : locked
                        ? `Stake locked — score ${state.trustScore} < ${minScore}`
                        : requestLocked
                          ? `Unstake in ${fmtDuration(secsToRequestable)}`
                          : "Request unstake (withdraw immediate)"}
                  </Button>
                ) : (
                  <>
                    <div className="flex items-center gap-2 rounded-2xl border border-line bg-white/[0.02] px-3 py-2 text-[12px] text-faint">
                      <Clock className="h-3.5 w-3.5" />
                      <>Unstaked — you can withdraw your collateral now, no waiting period.</>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        disabled={active}
                        onClick={() => cancelUnstake()}
                        className="rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground"
                        variant="ghost"
                      >
                        Cancel unstake
                      </Button>
                      <Button
                        disabled={active || exitBlocked}
                        onClick={() => withdraw()}
                        title={
                          busy ? "You are serving an active dispute"
                            : locked ? `Locked: score ${state.trustScore} < floor ${minScore}` : undefined
                        }
                        className="rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium hover:bg-white/20 disabled:opacity-50"
                      >
                        Withdraw stake
                      </Button>
                    </div>
                  </>
                )}

                <p className="flex items-start gap-2 pt-1 text-[11.5px] leading-relaxed text-faint">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Withdrawing returns your collateral and removes you from the roster — your soulbound badge stays
                    as history. Re-joining mints a <span className="num">fresh</span> badge and restarts the{" "}
                    {minStakeDays}d eligibility clock.
                  </span>
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Reduce confirmation modal ────────────────────────────────── */}
      <Dialog open={reduceModalOpen} onOpenChange={(v) => { if (!active) setReduceModalOpen(v); }}>
        <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
          <DialogHeader className="space-y-2 px-7 pb-4 pt-7">
            <DialogTitle className="text-xl tracking-tight">Reduce your stake</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-dim">
              Pull out collateral while staying in the pool. The remainder must stay above the minimum.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-7 pb-6 pt-1">
            <div>
              <label htmlFor="reduce-amount" className="num mb-1.5 block text-[11px] uppercase tracking-wider text-faint">
                amount (ETH)
              </label>
              <Input
                id="reduce-amount"
                value={reduceInput}
                onChange={(e) => setReduceInput(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                autoFocus
                disabled={active}
                className="h-11 flex-1 border-line bg-white/[0.03] text-base"
              />
              {reduceInvalid && (
                <p className="mt-1.5 text-[11.5px] text-faint">{reduceInvalid}</p>
              )}
            </div>

            <div className="space-y-2 rounded-2xl border border-line bg-white/[0.02] px-4 py-3.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-faint">Current stake</span>
                <span className="num text-dim">{formatEth(stakeTotal)} ETH</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">You receive</span>
                <span className="num text-dim">{reduceInput ? `${reduceInput} ETH` : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Remaining</span>
                <span className="num text-dim">
                  {formatEth(reduceRemaining >= 0n ? reduceRemaining : 0n)} ETH · {(TIER_NAMES[reduceTier] ?? "Unstaked").toLowerCase()}
                  {reduceTier < currentTier && <span className="ml-1 text-state-disputed">· tier down</span>}
                </span>
              </div>
            </div>

            {chain.error && (
              <p className="rounded-2xl border border-state-disputed/40 bg-state-disputed/[0.06] px-3.5 py-2.5 text-[12px] text-state-disputed">
                {chain.error}
              </p>
            )}
          </div>

          <DialogFooter className="hairline-t flex-col-reverse gap-2 px-7 py-5 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={active}
              onClick={() => setReduceModalOpen(false)}
              className="rounded-full border border-line px-5 text-dim hover:text-foreground"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={active || reduceInvalid !== null}
              onClick={() => reduce(reduceWei)}
              className="rounded-full bg-rose-accent px-6 font-medium hover:bg-rose-bright disabled:opacity-50"
            >
              {active ? (
                <span className="inline-flex items-center gap-2">
                  <SpinnerGap className="h-4 w-4 animate-spin" />
                  {PHASE_LABEL[chain.phase] ?? "Working…"}
                </span>
              ) : (
                "Confirm reduction"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Top-up confirmation modal ────────────────────────────────── */}
      <Dialog open={topUpModalOpen} onOpenChange={(v) => { if (!active) setTopUpModalOpen(v); }}>
        <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
          <DialogHeader className="space-y-2 px-7 pb-4 pt-7">
            <DialogTitle className="text-xl tracking-tight">Add to your stake</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-dim">
              Top up collateral to climb tiers. Takes effect on-chain as soon as the transaction mines.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-7 pb-6 pt-1">
            <div>
              <label htmlFor="topup-amount" className="num mb-1.5 block text-[11px] uppercase tracking-wider text-faint">
                amount (ETH)
              </label>
              <Input
                id="topup-amount"
                value={topUpInput}
                onChange={(e) => setTopUpInput(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                autoFocus
                disabled={active}
                className="h-11 flex-1 border-line bg-white/[0.03] text-base"
              />
            </div>

            <div className="space-y-2 rounded-2xl border border-line bg-white/[0.02] px-4 py-3.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-faint">Current stake</span>
                <span className="num text-dim">{formatEth(toWei(state?.stakeWei))} ETH</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">New total</span>
                <span className="num text-dim">
                  {formatEth(newTotalWei)} ETH · {(TIER_NAMES[newTier] ?? "Unstaked").toLowerCase()}
                  {newTier > currentTier && <span className="ml-1 text-state-released">· rank up</span>}
                </span>
              </div>
            </div>

            {chain.error && (
              <p className="rounded-2xl border border-state-disputed/40 bg-state-disputed/[0.06] px-3.5 py-2.5 text-[12px] text-state-disputed">
                {chain.error}
              </p>
            )}
          </div>

          <DialogFooter className="hairline-t flex-col-reverse gap-2 px-7 py-5 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={active}
              onClick={() => setTopUpModalOpen(false)}
              className="rounded-full border border-line px-5 text-dim hover:text-foreground"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={active || topUpWei <= 0n}
              onClick={() => add(topUpWei)}
              className="rounded-full bg-rose-accent px-6 font-medium hover:bg-rose-bright disabled:opacity-50"
            >
              {active ? (
                <span className="inline-flex items-center gap-2">
                  <SpinnerGap className="h-4 w-4 animate-spin" />
                  {PHASE_LABEL[chain.phase] ?? "Working…"}
                </span>
              ) : (
                "Confirm top-up"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Stake confirmation modal ─────────────────────────────────── */}
      <Dialog open={stakeModalOpen} onOpenChange={(v) => { if (!active) setStakeModalOpen(v); }}>
        <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
          <DialogHeader className="space-y-2 px-7 pb-4 pt-7">
            <DialogTitle className="text-xl tracking-tight">Stake collateral</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-dim">
              Deposit ETH to join the arbiter pool. Your collateral is locked while you serve — it can be
              slashed if you misbehave. You may request unstake after {cooldownDays}d of staking, and withdrawal
              then pays out immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-7 pb-6 pt-1">
            <div className="grid grid-cols-3 gap-2">
              {[
                { n: "Bronze", w: state?.minStakeWei ?? minStake },
                { n: "Silver", w: state?.tierSilverWei ?? minStake },
                { n: "Gold", w: state?.tierGoldWei ?? minStake },
              ].map((t) => (
                <button
                  key={t.n}
                  type="button"
                  disabled={active}
                  onClick={() => setStakeInput(formatEth(toWei(typeof t.w === "string" ? t.w : String(t.w))))}
                  className="rounded-2xl border border-line px-2 py-2.5 text-center hover:border-rose-accent/40 hover:bg-rose-soft"
                >
                  <div className="text-[12px] font-medium">{t.n}</div>
                  <div className="num mt-0.5 text-[11px] text-faint">{formatEth(toWei(typeof t.w === "string" ? t.w : String(t.w)))} ETH</div>
                </button>
              ))}
            </div>
            <div>
              <label htmlFor="stake-amount" className="num mb-1.5 block text-[11px] uppercase tracking-wider text-faint">
                amount (ETH)
              </label>
              <div className="flex gap-2">
                <Input
                  id="stake-amount"
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  placeholder={formatEth(minStake)}
                  inputMode="decimal"
                  autoFocus
                  disabled={active}
                  className="h-11 flex-1 border-line bg-white/[0.03] text-base"
                />
                <Button
                  type="button"
                  variant="ghost"
                  disabled={active}
                  onClick={() => setStakeInput(formatEth(toWei(minStake)))}
                  className="h-11 shrink-0 rounded-full border border-line px-4 text-[12.5px] text-dim hover:text-foreground"
                >
                  Min
                </Button>
              </div>
              <p className="mt-1.5 text-[11.5px] text-faint">
                Minimum <span className="num text-dim">{formatEth(minStake)} ETH</span>. Higher tiers (Silver/Gold) raise
                your selection weight — Escrow snapshots <span className="num">stakeOf</span> per round. You can top up later.
              </p>
              {!minKnown && (
                <p className="mt-1.5 text-[11.5px] text-state-disputed">
                  {!registryKnown
                    ? "App config still loading — contract addresses unknown."
                    : "Live registry reads are unavailable — tiers and minimums are estimates. Check your wallet network before confirming."}{" "}
                  {state?.readError && <span className="num block truncate opacity-80" title={state.readError}>last error: {state.readError}</span>}{" "}
                  <button
                    type="button"
                    disabled={retrying}
                    onClick={() => void retryReads()}
                    className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                  >
                    {retrying ? "Retrying…" : "Retry connection"}
                  </button>
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-2xl border border-line bg-white/[0.02] px-4 py-3.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-faint">You deposit</span>
                <span className="num text-dim">{stakeInput ? `${stakeInput} ETH` : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Selectable after</span>
                <span className="num text-dim">{minStakeDays}d of staking</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Unstakeable after</span>
                <span className="num text-dim">{cooldownDays}d staked</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Withdrawal</span>
                <span className="num text-dim">immediate</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Starting trust score</span>
                <span className="num text-state-released">100 / 100</span>
              </div>
            </div>

            {chain.error && (
              <p className="rounded-2xl border border-state-disputed/40 bg-state-disputed/[0.06] px-3.5 py-2.5 text-[12px] text-state-disputed">
                {chain.error}
              </p>
            )}
          </div>

          <DialogFooter className="hairline-t flex-col-reverse gap-2 px-7 py-5 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={active}
              onClick={() => setStakeModalOpen(false)}
              className="rounded-full border border-line px-5 text-dim hover:text-foreground"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={active || belowMin || !minKnown}
              onClick={() => register(stakeWei)}
              className="rounded-full bg-rose-accent px-6 font-medium hover:bg-rose-bright disabled:opacity-50"
              title={!minKnown ? "Live registry reads unavailable — check your wallet network" : undefined}
            >
              {active ? (
                <span className="inline-flex items-center gap-2">
                  <SpinnerGap className="h-4 w-4 animate-spin" />
                  {PHASE_LABEL[chain.phase] ?? "Working…"}
                </span>
              ) : (
                "Confirm stake"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A label/value row used in the position + rules lists. */
function RuleRow({ label, value, hint, accent, strong }: { label: string; value: string; hint?: string; accent?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn("text-faint", strong && "text-dim")}>
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-faint/70">{hint}</span>}
      </dt>
      <dd className={cn("num shrink-0 font-medium", accent ? "text-state-disputed" : strong ? "text-foreground" : "text-dim")}>{value}</dd>
    </div>
  );
}
