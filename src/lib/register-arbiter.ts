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
import { useWallet, readContract } from "@/lib/wallet";
import { useRuntime } from "@/lib/runtime";
import { REGISTRY_ABI } from "@/lib/contracts";
import {
  useChainAction, registerArbiterWithStakeAction, addStakeAction,
  requestUnstakeAction, cancelUnstakeAction, withdrawStakeAction,
} from "@/lib/chain-actions";

export interface MyArbiterState {
  registered: boolean;
  trustScore: number;
  stakeWei: string;
  locked: boolean;
  unstakeRequested: boolean;
  eligible: boolean;
  minStakeWei: string;
  minScoreToWithdraw: number;
}

/** Live on-chain state for the connected wallet's arbiter account. */
export function useMyArbiterState(): { state: MyArbiterState | null; refresh: () => void } {
  const { address } = useWallet();
  const registry = useRuntime((s) => s.registry);
  const [state, setState] = useState<MyArbiterState | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!registry || !address) {
      setState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const info = await readContract<readonly unknown[]>({
        to: registry, abi: REGISTRY_ABI, functionName: "arbiterInfo", args: [address],
      });
      const minStakeWei = await readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minStake" });
      const minScore = await readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minScoreToWithdraw" });
      const eligible = await readContract<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isEligible", args: [address] });
      const locked = await readContract<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isLocked", args: [address] });
      if (cancelled) return;
      if (!info) {
        setState({ registered: false, trustScore: 0, stakeWei: "0", locked: false, unstakeRequested: false, eligible: false, minStakeWei: (minStakeWei ?? 0n).toString(), minScoreToWithdraw: Number(minScore ?? 50n) });
        return;
      }
      setState({
        registered: Boolean(info[0]),
        unstakeRequested: Boolean(info[1]),
        trustScore: Number(info[3]),
        stakeWei: (info[4] as bigint).toString(),
        locked: Boolean(locked),
        eligible: Boolean(eligible),
        minStakeWei: (minStakeWei ?? 0n).toString(),
        minScoreToWithdraw: Number(minScore ?? 50n),
      });
    })();
    return () => { cancelled = true; };
  }, [registry, address, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refresh };
}

/** Staking actions for the connected wallet. */
export function useArbiterStaking() {
  const chain = useChainAction();
  const { state, refresh } = useMyArbiterState();
  const { address } = useWallet();

  const register = useCallback(async (stakeWei: bigint) => {
    const min = BigInt(state?.minStakeWei ?? "0");
    if (stakeWei < min) {
      toast.error("Stake below minimum", { description: `At least ${min.toString()} wei is required.` });
      return { ok: false };
    }
    const res = await registerArbiterWithStakeAction(chain.run)(stakeWei);
    if (res.ok) refresh();
    return res;
  }, [chain.run, state?.minStakeWei, refresh]);

  const add = useCallback(async (amountWei: bigint) => {
    const res = await addStakeAction(chain.run)(amountWei);
    if (res.ok) refresh();
    return res;
  }, [chain.run, refresh]);

  const requestUnstake = useCallback(async () => {
    const res = await requestUnstakeAction(chain.run)();
    if (res.ok) refresh();
    return res;
  }, [chain.run, refresh]);

  const cancelUnstake = useCallback(async () => {
    const res = await cancelUnstakeAction(chain.run)();
    if (res.ok) refresh();
    return res;
  }, [chain.run, refresh]);

  const withdraw = useCallback(async () => {
    const res = await withdrawStakeAction(chain.run)();
    if (res.ok) refresh();
    return res;
  }, [chain.run, refresh]);

  return { chain, state, address, register, add, requestUnstake, cancelUnstake, withdraw, refresh };
}
