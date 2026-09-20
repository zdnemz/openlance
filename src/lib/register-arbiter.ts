"use client";

/**
 * Arbiter staking — the client-side surface for joining/leaving the arbiter
 * pool with ETH collateral. Every action is a wallet tx against the registry;
 * the score/lock/eligibility reads come straight from the contract.
 *
 * Staking rules (enforced on-chain, explained here for the UI):
 *   · register needs >= MIN_STAKE; new arbiters start at trust score 100.
 *   · requestUnstake benches you from selection; withdraw needs an idle arbiter
 *     with score >= minScoreToWithdraw (else StakeIsLocked).
 *   · score 0 slashes the whole stake to the treasury.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet, readContract } from "@/lib/wallet";
import { useRuntime } from "@/lib/runtime";
import { qk } from "@/lib/queries";
import { REGISTRY_ABI, ESCROW_ABI } from "@/lib/contracts";
import { toWei } from "@/lib/format";
import {
  useChainAction, registerArbiterWithStakeAction, addStakeAction,
  requestUnstakeAction, cancelUnstakeAction, withdrawStakeAction,
} from "@/lib/chain-actions";

export interface MyArbiterState {
  registered: boolean;
  trustScore: number;
  stakeWei: string;
  /** 0 none · 1 bronze · 2 silver · 3 gold (mirrors Registry.tierOf). */
  tier: number;
  tierSilverWei: string;
  tierGoldWei: string;
  locked: boolean;
  unstakeRequested: boolean;
  eligible: boolean;
  minStakeWei: string;
  /** False when the minStake read failed — value checks below would be lies. */
  minStakeKnown: boolean;
  /** First chain-read failure reason (verbatim) — surfaced so users can report it. */
  readError: string | null;
  minScoreToWithdraw: number;
  /** Seconds of continuous stake required before selection. */
  minStakeDurationSeconds: number;
  /** Seconds between requestUnstake and withdrawStake. */
  unstakeCooldownSeconds: number;
  /** Unix seconds when the arbiter becomes eligible for selection (0 if unregistered). */
  eligibleAt: number;
  /** Unix seconds when a pending unstake may be withdrawn (0 if none pending). */
  unstakeReadyAt: number;
  /** On-chain "now" at read time, so the UI can compute countdowns consistently. */
  chainNow: number;
  /**
   * Count of in-flight dispute rounds this arbiter is committed to
   * (Escrow.activeDisputes). The registry's `_isBusy` gate reverts
   * requestUnstake/withdrawStake while this is > 0 — the UI mirrors it so a
   * user never signs a tx that will revert.
   */
  activeDisputes: number;
  /** Convenience: `activeDisputes > 0` (the contract's busy condition). */
  busy: boolean;
}

/** Live on-chain state for the connected wallet's arbiter account. */
export function useMyArbiterState(): { state: MyArbiterState | null; refresh: () => void } {
  const { address } = useWallet();
  const registry = useRuntime((s) => s.registry);
  const escrow = useRuntime((s) => s.escrow);
  const [state, setState] = useState<MyArbiterState | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!registry || !address) {
      setState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let firstErr: string | null = null;
      const noteErr = (fn: string, message: string) => { firstErr ??= `${fn}: ${message}`; };
      const rc = <T,>(o: Omit<Parameters<typeof readContract>[0], "onError">) =>
        readContract<T>({ ...o, onError: noteErr });
      const info = await rc<readonly unknown[]>({
        to: registry, abi: REGISTRY_ABI, functionName: "arbiterInfo", args: [address],
      });
      const minStakeWei = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minStake" });
      const minScore = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minScoreToWithdraw" });
      const minStakeDuration = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minStakeDuration" });
      const unstakeCooldown = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "unstakeCooldown" });
      const eligible = await rc<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isEligible", args: [address] });
      const locked = await rc<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isLocked", args: [address] });
      const eligibleAt = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "eligibleAt", args: [address] });
      const unstakeReadyAt = await rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "unstakeReadyAt", args: [address] });
      // Tier reads are optional (fall back to minStake×2/×5) — don't let them
      // mask or trigger the load-bearing readError below.
      const tier = await readContract<number>({ to: registry, abi: REGISTRY_ABI, functionName: "tierOf", args: [address] }).catch(() => 0);
      const tierSilver = await readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "tierSilver" }).catch(() => null);
      const tierGold = await readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "tierGold" }).catch(() => null);
      // The escrow owns the "active dispute" bookkeeping the registry's _isBusy
      // guard consults; read it directly so the UI matches the revert condition.
      const activeDisputesRaw = escrow
        ? await rc<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "activeDisputes", args: [address] })
        : null;
      const activeDisputes = Number(activeDisputesRaw ?? 0n);
      const chainNow = Math.floor(Date.now() / 1000);
      if (cancelled) return;
      // tierSilver/Gold default to minStake*2/*5 (registry initialize) when the
      // view call is unavailable — never collapse them onto minStake.
      const min = minStakeWei ?? 0n;
      const silverFallback = tierSilver ?? (min ? min * 2n : 0n);
      const goldFallback = tierGold ?? (min ? min * 5n : 0n);
      if (!info) {
        setState({
          registered: false, trustScore: 0, stakeWei: "0", tier: 0,
          tierSilverWei: silverFallback.toString(),
          tierGoldWei: goldFallback.toString(), locked: false, unstakeRequested: false, eligible: false,
          minStakeWei: (minStakeWei ?? 0n).toString(), minStakeKnown: minStakeWei !== null, readError: firstErr, minScoreToWithdraw: Number(minScore ?? 50n),
          minStakeDurationSeconds: Number(minStakeDuration ?? 0n), unstakeCooldownSeconds: Number(unstakeCooldown ?? 0n),
          eligibleAt: 0, unstakeReadyAt: 0, chainNow, activeDisputes: 0, busy: false,
        });
        return;
      }
      setState({
        registered: Boolean(info[0]),
        unstakeRequested: Boolean(info[1]),
        trustScore: Number(info[3]),
        stakeWei: (info[4] as bigint).toString(),
        tier: Number(tier ?? 0),
        tierSilverWei: silverFallback.toString(),
        tierGoldWei: goldFallback.toString(),
        locked: Boolean(locked),
        eligible: Boolean(eligible),
        minStakeWei: (minStakeWei ?? 0n).toString(),
        minStakeKnown: minStakeWei !== null,
        readError: firstErr,
        minScoreToWithdraw: Number(minScore ?? 50n),
        minStakeDurationSeconds: Number(minStakeDuration ?? 0n),
        unstakeCooldownSeconds: Number(unstakeCooldown ?? 0n),
        eligibleAt: Number(eligibleAt ?? 0n),
        unstakeReadyAt: Number(unstakeReadyAt ?? 0n),
        chainNow,
        activeDisputes,
        busy: activeDisputes > 0,
      });
    })();
    return () => { cancelled = true; };
  }, [registry, escrow, address, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refresh };
}

/** Staking actions for the connected wallet. */
export function useArbiterStaking() {
  const chain = useChainAction();
  const { state, refresh } = useMyArbiterState();
  const { address } = useWallet();
  const qc = useQueryClient();
  // Chain reads + off-chain mirrors converge after every stake tx; without
  // this the panel keeps offering "join" for a registered arbiter (whose next
  // register would revert AlreadyRegistered).
  const synced = useCallback(() => {
    refresh();
    void qc.invalidateQueries({ queryKey: qk.arbiters });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }, [refresh, qc]);

  const register = useCallback(async (stakeWei: bigint) => {
    if (!state?.minStakeKnown) {
      toast.error("Registry unreachable", { description: "Couldn't read the live minimum — check your wallet network and retry." });
      return { ok: false };
    }
    const min = toWei(state?.minStakeWei ?? "0");
    if (stakeWei < min) {
      toast.error("Stake below minimum", { description: `At least ${min.toString()} wei is required.` });
      return { ok: false };
    }
    const res = await registerArbiterWithStakeAction(chain.run)(stakeWei);
    if (res.ok) synced();
    return res;
  }, [chain.run, state?.minStakeWei, state?.minStakeKnown, synced]);

  const add = useCallback(async (amountWei: bigint) => {
    const res = await addStakeAction(chain.run)(amountWei);
    if (res.ok) synced();
    return res;
  }, [chain.run, synced]);

  const requestUnstake = useCallback(async () => {
    const res = await requestUnstakeAction(chain.run)();
    if (res.ok) synced();
    return res;
  }, [chain.run, synced]);

  const cancelUnstake = useCallback(async () => {
    const res = await cancelUnstakeAction(chain.run)();
    if (res.ok) synced();
    return res;
  }, [chain.run, synced]);

  const withdraw = useCallback(async () => {
    const res = await withdrawStakeAction(chain.run)();
    if (res.ok) synced();
    return res;
  }, [chain.run, synced]);

  return { chain, state, address, register, add, requestUnstake, cancelUnstake, withdraw, refresh };
}
