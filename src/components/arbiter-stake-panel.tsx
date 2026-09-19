"use client";

/**
 * ArbiterStakePanel — the self-service staking surface.
 *
 * Every gate here mirrors a revert in ArbiterRegistry.sol, so a user never
 * signs a transaction that is guaranteed to fail:
 *
 *   registerArbiter()  requires msg.value ≥ minStake, not already registered
 *   addStake()         requires registered, value > 0
 *   requestUnstake()   reverts when: not registered · already requested · stake 0
 *                      · busy (activeDisputes > 0) · score < minScoreToWithdraw
 *   cancelUnstake()    requires a pending request
 *   withdrawStake()    reverts when: not registered · not requested · busy
 *                      · cooldown not elapsed · score < minScoreToWithdraw
 *                      → on success it DEREGISTERS the arbiter (leaves the
 *                        roster) but the soulbound badge stays as history.
 *
 * Trust score is bounded to [0,100]; the only way it rises is a majority vote
 * (+5). It never self-recovers — a locked arbiter must win rounds to climb back.
 */
import { useEffect, useState } from "react";
import { useWallet, useWalletHydrated } from "@/lib/wallet";
import { useArbiterStaking, type MyArbiterState } from "@/lib/register-arbiter";
import { useRuntime } from "@/lib/runtime";
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
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { Info } from "@phosphor-icons/react/dist/csr/Info";

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

/** One line explaining the current on-chain standing, derived from the contract. */
function statusLabel(state: MyArbiterState, minsToEligible: number, minsToWithdraw: number): string {
  if (!state.registered) return "not registered";
  if (state.locked) return `locked — score ${state.trustScore} < floor ${state.minScoreToWithdraw}`;
  if (state.unstakeRequested) {
    return minsToWithdraw > 0 ? `unstaking — withdraw in ${fmtDuration(minsToWithdraw * 60)}` : "unstaking — ready to withdraw";
  }
  if (state.busy) return `serving ${state.activeDisputes} dispute${state.activeDisputes === 1 ? "" : "s"}`;
  if (state.eligible) return "eligible for selection";
  return `eligible in ${fmtDuration(minsToEligible * 60)}`;
}

export function ArbiterStakePanel() {
  const { address } = useWallet();
  const hydrated = useWalletHydrated();
  const { state, register, add, requestUnstake, cancelUnstake, withdraw, chain } = useArbiterStaking();
  const { minStakeWei, minScoreToWithdraw } = useRuntime();
  const [stakeModalOpen, setStakeModalOpen] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [topUpInput, setTopUpInput] = useState("");
  const active = chain.phase !== "idle" && chain.phase !== "done";

  const ethToWei = (v: string): bigint => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0n;
    return BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 1e6 * 1e12 = 1e18
  };

  /**
   * Safe wei parser — the min-stake value can arrive as `undefined` while the
   * runtime config is still loading (or if the API omits it), and `BigInt()`
   * throws on `undefined`. Coerce anything non-numeric to 0n so render never
   * crashes; `formatEth` handles the presentation of the raw value.
   */
  const toWei = (v: string | bigint | null | undefined): bigint => {
    if (typeof v === "bigint") return v;
    if (typeof v !== "string" || v.length === 0) return 0n;
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  };

  const stakeWei = ethToWei(stakeInput);
  const minStake = state?.minStakeWei ?? minStakeWei;
  const belowMin = stakeWei < toWei(minStake);

  // Close the modal once the stake tx has fully settled (signed + mined), and
  // reset the amount so the next open starts clean.
  useEffect(() => {
    if (stakeModalOpen && chain.phase === "done" && state?.registered) {
      setStakeModalOpen(false);
      setStakeInput("");
    }
  }, [stakeModalOpen, chain.phase, state?.registered]);

  // The wallet lives in a persisted store, so `address` is always null during
  // SSR and the first client render, then flips once localStorage rehydrates.
  // Rendering the "connect" copy before that flip would change the tree on the
  // client and trip React's hydration check — so show a stable placeholder
  // until hydration completes, then branch on the real address.
  if (!hydrated) {
    return (
      <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-6 text-[13px] text-faint">
        Checking your wallet…
      </div>
    );
  }

  if (!address) {
    return (
      <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-6 text-[13px] text-faint">
        Connect a wallet to join the arbiter pool.
      </div>
    );
  }

  const minScore = state?.minScoreToWithdraw ?? minScoreToWithdraw ?? 0;

  // Time-based rules surfaced in the UI (mirror the on-chain registry rules).
  const minStakeDays = state ? Math.max(1, Math.round(state.minStakeDurationSeconds / 86400)) : 0;
  const cooldownDays = state ? Math.max(0, Math.round(state.unstakeCooldownSeconds / 86400)) : 0;
  const nowSec = state?.chainNow ?? Math.floor(Date.now() / 1000);
  const minsToEligible = state ? Math.max(0, Math.ceil((state.eligibleAt - nowSec) / 60)) : 0;
  const minsToWithdraw = state ? Math.max(0, Math.ceil((state.unstakeReadyAt - nowSec) / 60)) : 0;
  const busy = Boolean(state?.busy);
  const locked = Boolean(state?.locked);
  // requestUnstake/withdrawShare the same on-chain guard set.
  const exitBlocked = busy || locked;
  const cooldownActive = Boolean(state?.unstakeRequested && minsToWithdraw > 0);

  return (
    <div className="rounded-3xl border border-line bg-white/[0.012] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-state-split" />
          <h2 className="text-[16px] font-medium tracking-tight">Your arbiter stake</h2>
        </div>
        {state?.registered ? (
          <span className={`num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${busy ? "border-state-submitted/40 text-state-submitted" : state.locked ? "border-state-disputed/40 text-state-disputed" : state.eligible ? "border-state-released/40 text-state-released" : "border-line text-dim"}`}>
            {busy ? <Gavel className="h-3.5 w-3.5" /> : state.locked ? <ShieldWarning className="h-3.5 w-3.5" /> : state.unstakeRequested ? <Clock className="h-3.5 w-3.5" /> : state.eligible ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {statusLabel(state, minsToEligible, minsToWithdraw)}
          </span>
        ) : (
          <span className="num rounded-full border border-line px-3 py-1 text-[11.5px] text-faint">not registered</span>
        )}
      </div>

      {/* state summary */}
      {state?.registered && (
        <div className="mt-5 grid grid-cols-3 gap-4 border-y border-line py-4">
          <div>
            <div className="num text-[11px] uppercase tracking-wider text-faint">stake</div>
            <div className="num mt-1 text-lg font-medium">{formatEth(toWei(state.stakeWei))} ETH</div>
          </div>
          <div>
            <div className="num text-[11px] uppercase tracking-wider text-faint">trust score</div>
            <div className={`num mt-1 text-lg font-medium ${state.locked ? "text-state-disputed" : "text-state-released"}`}>
              {state.trustScore}
              <span className="ml-1 text-[11px] font-normal text-faint">/ 100</span>
            </div>
          </div>
          <div>
            <div className="num text-[11px] uppercase tracking-wider text-faint">lock floor</div>
            <div className="num mt-1 text-lg font-medium text-dim">
              {minScore}
              <span className="ml-1 text-[11px] font-normal text-faint">score</span>
            </div>
          </div>
        </div>
      )}

      {/* serving notice — the only thing that blocks a voluntary exit */}
      {busy && (
        <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-state-submitted/30 bg-state-submitted/[0.06] px-3.5 py-3 text-[12.5px] text-dim">
          <Gavel className="mt-0.5 h-4 w-4 shrink-0 text-state-submitted" />
          <span>
            You are committed to <span className="num text-foreground">{state!.activeDisputes}</span> in-flight dispute
            {state!.activeDisputes === 1 ? "" : "s"}. The contract blocks both <span className="num">requestUnstake</span> and{" "}
            <span className="num">withdrawStake</span> until every round you are serving on is resolved.
          </span>
        </div>
      )}

      {/* actions */}
      <div className="mt-5 space-y-3">
        {!state?.registered ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-faint">
              Join the pool by depositing at least <span className="num text-dim">{formatEth(minStake)} ETH</span> collateral.
              You start at trust score <span className="num text-dim">100/100</span> and become selectable after{" "}
              <span className="num text-dim">{minStakeDays}d</span> of continuous staking. If your score falls below{" "}
              <span className="num text-dim">{minScore}</span> your stake locks; at <span className="num text-dim">0</span> it is
              slashed in full to the treasury. Withdrawing has a <span className="num text-dim">{cooldownDays}d</span> cooldown.
            </p>
            <Button
              onClick={() => setStakeModalOpen(true)}
              className="w-full rounded-full bg-rose-accent py-2.5 text-[13px] font-medium hover:bg-rose-bright"
            >
              Stake &amp; join the pool
            </Button>
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                value={topUpInput}
                onChange={(e) => setTopUpInput(e.target.value)}
                placeholder="Add collateral (ETH)"
                inputMode="decimal"
                className="h-10 border-line bg-white/[0.03] text-sm"
              />
              <Button
                disabled={active || ethToWei(topUpInput) <= 0n}
                onClick={() => add(ethToWei(topUpInput))}
                className="shrink-0 rounded-full border border-line px-5 text-dim hover:text-foreground"
                variant="ghost"
              >
                Add stake
              </Button>
            </div>

            {!state.unstakeRequested ? (
              <Button
                disabled={active || exitBlocked}
                onClick={() => requestUnstake()}
                title={
                  busy ? `You are serving ${state.activeDisputes} active dispute${state.activeDisputes === 1 ? "" : "s"}`
                    : locked ? `Locked: score ${state.trustScore} < floor ${minScore}`
                      : `Cooldown ${cooldownDays}d before withdrawal`
                }
                className="w-full rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground disabled:opacity-50"
                variant="ghost"
              >
                {busy
                  ? `Bench blocked — serving ${state.activeDisputes} dispute${state.activeDisputes === 1 ? "" : "s"}`
                  : locked
                    ? `Stake locked — score ${state.trustScore} < ${minScore}`
                    : `Unstake (starts ${cooldownDays}d cooldown)`}
              </Button>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-2xl border border-line bg-white/[0.02] px-3 py-2 text-[12px] text-faint">
                  <Clock className="h-3.5 w-3.5" />
                  {cooldownActive
                    ? <>Unstake requested — collateral unlocks in <span className="num text-dim">{fmtDuration(minsToWithdraw * 60)}</span>.</>
                    : <>Cooldown complete — you can withdraw your collateral now.</>}
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
                    disabled={active || exitBlocked || cooldownActive}
                    onClick={() => withdraw()}
                    title={
                      busy ? "You are serving an active dispute"
                        : locked ? `Locked: score ${state.trustScore} < floor ${minScore}`
                          : cooldownActive ? `Wait ${fmtDuration(minsToWithdraw * 60)} for the cooldown` : undefined
                    }
                    className="rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium hover:bg-white/20 disabled:opacity-50"
                  >
                    {cooldownActive ? `Withdraw (${fmtDuration(minsToWithdraw * 60)} left)` : "Withdraw stake"}
                  </Button>
                </div>
                <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-faint">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Withdrawing returns your collateral and removes you from the roster — your soulbound badge stays
                    as history. Re-joining mints a <span className="num">fresh</span> badge and restarts the{" "}
                    {minStakeDays}d eligibility clock.
                  </span>
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Stake confirmation modal ─────────────────────────────────────── */}
      <Dialog open={stakeModalOpen} onOpenChange={(v) => { if (!active) setStakeModalOpen(v); }}>
        <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
          <DialogHeader className="space-y-2 px-7 pb-4 pt-7">
            <DialogTitle className="text-xl tracking-tight">Stake collateral</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-dim">
              Deposit ETH to join the arbiter pool. Your collateral is locked while you serve — it can be
              slashed if you misbehave, and released only after a {cooldownDays}d unstake cooldown.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-7 pb-6 pt-1">
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
                Minimum <span className="num text-dim">{formatEth(minStake)} ETH</span>. You can top up later.
              </p>
            </div>

            {/* recap of the rules that bind this stake */}
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
                <span className="text-faint">Unstake cooldown</span>
                <span className="num text-dim">{cooldownDays}d</span>
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
              disabled={active || belowMin}
              onClick={() => register(stakeWei)}
              className="rounded-full bg-rose-accent px-6 font-medium hover:bg-rose-bright disabled:opacity-50"
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
