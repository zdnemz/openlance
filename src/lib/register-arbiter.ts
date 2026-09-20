"use client";

/**
 * Arbiter staking — the client-side surface for joining/leaving the arbiter
 * pool with ETH collateral. Every action is a wallet tx against the registry;
 * the score/lock/eligibility reads come straight from the contract.
 *
 * Staking rules (enforced on-chain, explained here for the UI):
 *   · register needs >= MIN_STAKE; new arbiters start at trust score 100.
 *   · requestUnstake needs a stake aged >= unstakeCooldown and benches you
 *     from selection; withdrawStake then pays out immediately (no second wait).
 *   · withdraw needs an idle arbiter with score >= minScoreToWithdraw
 *     (else StakeIsLocked).
 *   · score 0 slashes the whole stake to the treasury.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet, readContract } from "@/lib/wallet";
import { useRuntime } from "@/lib/runtime";
import { get, qk } from "@/lib/queries";
import type { ArbiterView } from "@/lib/types";
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
  /** Seconds staked before requestUnstake may be called (withdraw is immediate). */
  unstakeCooldownSeconds: number;
  /** Unix seconds when the arbiter becomes eligible for selection (0 if unregistered). */
  eligibleAt: number;
  /** Unix seconds when a pending unstake may be withdrawn (0 if none pending). */
  unstakeReadyAt: number;
  /** On-chain "now" at read time, so the UI can compute countdowns consistently. */
  chainNow: number;
  /** Count of in-flight dispute rounds this arbiter is committed to
   * (Escrow.activeDisputes). The registry's `_isBusy` gate reverts
   * requestUnstake/withdrawStake while this is > 0 — the UI mirrors it so a
   * user never signs a tx that will revert.
   */
  activeDisputes: number;
  /** False when the escrow read failed — busy is unknown, exits stay shut. */
  busyKnown: boolean;
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
      try {
        let firstErr: string | null = null;
        const noteErr = (fn: string, message: string) => { firstErr ??= `${fn}: ${message}`; };
        const rc = <T,>(o: Omit<Parameters<typeof readContract>[0], "onError">) =>
          readContract<T>({ ...o, onError: noteErr });
        // One parallel burst, not 13 sequential round trips. Every read is
        // null-safe, so one failing view can't sink the batch.
        const [
          infoRaw, minStakeWei, minScore, minStakeDuration, unstakeCooldown,
          eligible, locked, eligibleAt, unstakeReadyAt, activeDisputesRaw,
          tier, tierSilver, tierGold,
        ] = await Promise.all([
          rc<readonly unknown[]>({ to: registry, abi: REGISTRY_ABI, functionName: "arbiterInfo", args: [address] }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minStake" }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minScoreToWithdraw" }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "minStakeDuration" }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "unstakeCooldown" }),
          rc<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isEligible", args: [address] }),
          rc<boolean>({ to: registry, abi: REGISTRY_ABI, functionName: "isLocked", args: [address] }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "eligibleAt", args: [address] }),
          rc<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "unstakeReadyAt", args: [address] }),
          escrow ? rc<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "activeDisputes", args: [address] }) : Promise.resolve(null),
          // Tier reads are optional (fall back to minStake×2/×5) — plain reads
          // so they neither mask nor trigger the load-bearing readError below.
          readContract<number>({ to: registry, abi: REGISTRY_ABI, functionName: "tierOf", args: [address] }).catch(() => 0),
          readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "tierSilver" }).catch(() => null),
          readContract<bigint>({ to: registry, abi: REGISTRY_ABI, functionName: "tierGold" }).catch(() => null),
        ]);
        if (cancelled) return;
        // viem decodes a NAMED-component tuple (see REGISTRY_ABI.arbiterInfo)
        // to an object {registered, …}, not an array — positional indexing
        // reads undefined and crashes below. Read by name, index as fallback.
        const info = infoRaw;
        const field = (i: number, name: string): unknown => {
          if (Array.isArray(info)) {
            if (info.length === 1 && info[0] !== null && typeof info[0] === "object" && !Array.isArray(info[0])) {
              const o = info[0] as unknown as Record<string, unknown>;
              if (name in o) return o[name];
            }
            return (info as readonly unknown[])[i];
          }
          if (info !== null && typeof info === "object") {
            const o = info as unknown as Record<string, unknown>;
            if (name in o) return o[name];
          }
          return undefined;
        };
        if (info === null && !firstErr) firstErr = "arbiterInfo: read failed";
        const big = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);
        const num = (v: unknown, fb = 0): number => {
          if (typeof v === "bigint") return Number(v);
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "boolean") return v ? 1 : 0;
          return fb;
        };
        // The escrow owns the "active dispute" bookkeeping the registry's
        // _isBusy guard consults; a failed read means "unknown", never 0.
        const activeDisputes = activeDisputesRaw === null ? 0 : num(activeDisputesRaw);
      const chainNow = Math.floor(Date.now() / 1000);
      if (cancelled) return;
      // tierSilver/Gold default to minStake*10/*100 (registry initialize:
      // Silver 1 ETH, Gold 10 ETH) when the view call is unavailable — never
      // collapse them onto minStake.
      const min = minStakeWei ?? 0n;
      const silverFallback = tierSilver ?? (min ? min * 10n : 0n);
      const goldFallback = tierGold ?? (min ? min * 100n : 0n);
      if (!info) {
        setState({
          registered: false, trustScore: 0, stakeWei: "0", tier: 0,
          tierSilverWei: silverFallback.toString(),
          tierGoldWei: goldFallback.toString(), locked: false, unstakeRequested: false, eligible: false,
          minStakeWei: (minStakeWei ?? 0n).toString(), minStakeKnown: minStakeWei !== null, readError: firstErr, minScoreToWithdraw: Number(minScore ?? 50n),
          minStakeDurationSeconds: Number(minStakeDuration ?? 0n), unstakeCooldownSeconds: Number(unstakeCooldown ?? 0n),
          eligibleAt: 0, unstakeReadyAt: 0, chainNow, activeDisputes: 0, busy: false, busyKnown: activeDisputesRaw !== null,
        });
        return;
      }
      setState({
        registered: field(0, "registered") === true,
        unstakeRequested: field(1, "unstakeRequested") === true,
        trustScore: num(field(3, "trustScore"), 0),
        stakeWei: big(field(4, "stake")).toString(),
        tier: num(tier, 0),
        tierSilverWei: silverFallback.toString(),
        tierGoldWei: goldFallback.toString(),
        locked: Boolean(locked),
        eligible: Boolean(eligible),
        minStakeWei: (minStakeWei ?? 0n).toString(),
        minStakeKnown: minStakeWei !== null,
        readError: firstErr,
        minScoreToWithdraw: num(minScore, 50),
        minStakeDurationSeconds: num(minStakeDuration, 0),
        unstakeCooldownSeconds: num(unstakeCooldown, 0),
        eligibleAt: num(eligibleAt, 0),
        unstakeReadyAt: num(unstakeReadyAt, 0),
        chainNow,
        activeDisputes,
        busy: activeDisputes > 0,
        busyKnown: activeDisputesRaw !== null,
      });
      } catch (err) {
        // Never an unhandled rejection: keep the last good state and surface
        // the reason for the next render.
        if (!cancelled) {
          const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
          setState((prev) => (prev ? { ...prev, readError: prev.readError ?? msg } : prev));
        }
      }
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
  const synced = useCallback(async (wait?: () => Promise<void>) => {
    refresh(); // chain truth first — the panel flips immediately
    if (wait) await wait(); // …then invalidate once the mirror caught up
    void qc.invalidateQueries({ queryKey: qk.arbiters });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }, [refresh, qc]);

  /** Poll the off-chain mirror until it reflects the just-mined tx (~20s max —
   *  the list polls anyway). Invalidating before the mirror flips just
   *  re-caches stale rows: the "must reload" complaint. */
  const awaitMirror = useCallback(async (pred: (list: ArbiterView[]) => boolean) => {
    for (let i = 0; i < 13; i++) {
      try {
        if (pred(await get<ArbiterView[]>("/arbiters"))) return;
      } catch { /* transient — keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, []);

  const mine = useCallback((list: ArbiterView[]) => {
    const me = (address ?? "").toLowerCase();
    return me ? list.find((a) => a.address.toLowerCase() === me) : undefined;
  }, [address]);

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
    if (!res.ok) return res;
    await synced(() => awaitMirror((l) => mine(l)?.registered === true));
    return res;
  }, [chain.run, state?.minStakeWei, state?.minStakeKnown, synced, awaitMirror, mine]);

  const add = useCallback(async (amountWei: bigint) => {
    const before = toWei(state?.stakeWei ?? "0");
    const res = await addStakeAction(chain.run)(amountWei);
    if (!res.ok) return res;
    await synced(() => awaitMirror((l) => {
      try { return BigInt(mine(l)?.stakeWei ?? "0") >= before + amountWei; } catch { return false; }
    }));
    return res;
  }, [chain.run, state?.stakeWei, synced, awaitMirror, mine]);

  const requestUnstake = useCallback(async () => {
    const res = await requestUnstakeAction(chain.run)();
    if (!res.ok) return res;
    await synced(() => awaitMirror((l) => mine(l)?.unstakeRequested === true));
    return res;
  }, [chain.run, synced, awaitMirror, mine]);

  const cancelUnstake = useCallback(async () => {
    const res = await cancelUnstakeAction(chain.run)();
    if (!res.ok) return res;
    await synced(() => awaitMirror((l) => { const e = mine(l); return !!e && !e.unstakeRequested; }));
    return res;
  }, [chain.run, synced, awaitMirror, mine]);

  const withdraw = useCallback(async () => {
    const res = await withdrawStakeAction(chain.run)();
    if (!res.ok) return res;
    await synced(() => awaitMirror((l) => { const e = mine(l); return !e || !e.registered; }));
    return res;
  }, [chain.run, synced, awaitMirror, mine]);

  return { chain, state, address, register, add, requestUnstake, cancelUnstake, withdraw, refresh };
}
