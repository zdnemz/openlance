"use client";

/**
 * ArbiterStakePanel — the self-service staking surface.
 *
 * Reads the connected wallet's live arbiter state from the registry and offers
 * the full lifecycle: join (deposit collateral), top up, request-unstake (bench),
 * cancel, and withdraw. Enforces the on-chain rules in the copy so the user
 * understands why a button is disabled (locked stake, active dispute, …).
 */
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useArbiterStaking } from "@/lib/register-arbiter";
import { useRuntime } from "@/lib/runtime";
import { formatEth } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock } from "@phosphor-icons/react/dist/csr/Lock";
import { LockOpen } from "@phosphor-icons/react/dist/csr/LockOpen";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";

export function ArbiterStakePanel() {
  const { address } = useWallet();
  const { state, register, add, requestUnstake, cancelUnstake, withdraw, chain } = useArbiterStaking();
  const { minStakeWei, minScoreToWithdraw } = useRuntime();
  const [stakeInput, setStakeInput] = useState("");
  const [topUpInput, setTopUpInput] = useState("");
  const active = chain.phase !== "idle" && chain.phase !== "done";

  const ethToWei = (v: string): bigint => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0n;
    return BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 1e6 * 1e12 = 1e18
  };

  if (!address) {
    return (
      <div className="rounded-3xl border border-line bg-white/[0.012] px-6 py-6 text-[13px] text-faint">
        Connect a wallet to join the arbiter pool.
      </div>
    );
  }

  const minStake = state?.minStakeWei ?? minStakeWei;
  const minScore = state?.minScoreToWithdraw ?? minScoreToWithdraw;

  return (
    <div className="rounded-3xl border border-line bg-white/[0.012] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-state-split" />
          <h2 className="text-[16px] font-medium tracking-tight">Your arbiter stake</h2>
        </div>
        {state?.registered ? (
          <span className={`num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${state.eligible ? "border-state-released/40 text-state-released" : state.locked ? "border-state-disputed/40 text-state-disputed" : "border-line text-dim"}`}>
            {state.locked ? <ShieldWarning className="h-3.5 w-3.5" /> : state.eligible ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {state.locked ? "locked — score below threshold" : state.unstakeRequested ? "unstaking — benched" : state.eligible ? "eligible for selection" : "registered"}
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
            <div className="num mt-1 text-lg font-medium">{formatEth(BigInt(state.stakeWei))} ETH</div>
          </div>
          <div>
            <div className="num text-[11px] uppercase tracking-wider text-faint">trust score</div>
            <div className={`num mt-1 text-lg font-medium ${state.locked ? "text-state-disputed" : "text-state-released"}`}>{state.trustScore}</div>
          </div>
          <div>
            <div className="num text-[11px] uppercase tracking-wider text-faint">min to withdraw</div>
            <div className="num mt-1 text-lg font-medium text-dim">{minScore}</div>
          </div>
        </div>
      )}

      {/* actions */}
      <div className="mt-5 space-y-3">
        {!state?.registered ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-faint">
              Join the pool by depositing at least <span className="num text-dim">{formatEth(BigInt(minStake))} ETH</span> collateral.
              New arbiters start at trust score 100. Below {minScore} your stake locks; at 0 it is slashed to the treasury.
            </p>
            <div className="flex gap-2">
              <Input
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value)}
                placeholder={formatEth(BigInt(minStake))}
                inputMode="decimal"
                className="h-10 border-line bg-white/[0.03] text-sm"
              />
              <Button
                disabled={active || ethToWei(stakeInput) < BigInt(minStake)}
                onClick={() => register(ethToWei(stakeInput))}
                className="shrink-0 rounded-full bg-rose-accent px-6 hover:bg-rose-bright"
              >
                {active ? "…" : "Stake & join"}
              </Button>
            </div>
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
                disabled={active || state.locked}
                onClick={() => requestUnstake()}
                title={state.locked ? `Locked: score ${state.trustScore} < ${minScore}` : undefined}
                className="w-full rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground"
                variant="ghost"
              >
                {state.locked ? `Stake locked — score ${state.trustScore} < ${minScore}` : "Request unstake (leaves the pool)"}
              </Button>
            ) : (
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
                  disabled={active || state.locked}
                  onClick={() => withdraw()}
                  className="rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium hover:bg-white/20"
                >
                  Withdraw stake
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
