"use client";

/**
 * Live dispute-round reads + commit-reveal helpers.
 *
 * The API mirror lags and is only a cache; for anything the arbiter is about to
 * sign we read the contract directly (eth_call via the relay). This module is
 * the single place that knows how a commit hash is computed and how the round
 * phase is derived, so the UI and the contract can never drift.
 */
import { useEffect, useState } from "react";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { readContract } from "@/lib/wallet";
import { useRuntime } from "@/lib/runtime";
import { ESCROW_ABI, QUORUM } from "@/lib/contracts";
import type { DisputePhase, DisputeView } from "@/lib/types";

export type RoundState = {
  arbiters: string[]; // zero-address filtered, length = arbiterCount
  arbiterCount: number;
  commitCount: number;
  revealCount: number;
  tally: number[]; // [release, refund, split]
  commitDeadline: number; // unix seconds
  revealDeadline: number;
  resolved: boolean;
  winningOutcome: number;
  /** Derived phase from deadlines + resolved flag. */
  phase: DisputePhase;
};

/** keccak256(abi.encode(outcome, salt, arbiter, milestoneId, round)) — must match the contract. */
export function computeCommitHash(
  outcome: number,
  salt: `0x${string}`,
  arbiter: string,
  milestoneId: bigint,
  round: number,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint8,bytes32,address,uint256,uint8"), [
      outcome,
      salt,
      arbiter as `0x${string}`,
      milestoneId,
      round,
    ]),
  );
}

/** A fresh 32-byte salt. Uses crypto.getRandomValues — never reused across reveals. */
export function makeSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function derivePhase(resolved: boolean, now: number, commitDeadline: number, revealDeadline: number): DisputePhase {
  if (resolved) return "resolved";
  if (now < commitDeadline) return "commit";
  if (now <= revealDeadline) return "reveal";
  return "reveal"; // deadline passed but not yet tallied — still "reveal" (tally pending)
}

export async function fetchRound(escrow: string, milestoneId: bigint, round: number): Promise<RoundState | null> {
  const raw = await readContract<readonly unknown[]>({
    to: escrow,
    abi: ESCROW_ABI,
    functionName: "getRound",
    args: [milestoneId, round],
  });
  if (!raw) return null;
  const arbiters = (raw[0] as string[]).slice(0, Number(raw[1])).filter((a) => a.toLowerCase() !== ZERO);
  const commitDeadline = Number(raw[5] as bigint);
  const revealDeadline = Number(raw[6] as bigint);
  const resolved = Boolean(raw[7]);
  return {
    arbiters,
    arbiterCount: Number(raw[1]),
    commitCount: Number(raw[2]),
    revealCount: Number(raw[3]),
    tally: (raw[4] as number[]).map(Number),
    commitDeadline,
    revealDeadline,
    resolved,
    winningOutcome: Number(raw[8]),
    phase: derivePhase(resolved, Math.floor(Date.now() / 1000), commitDeadline, revealDeadline),
  };
}

/** Whether `address` is one of the selected arbiters for this round. */
export function isSelected(round: RoundState | null, address: string | null | undefined): boolean {
  if (!round || !address) return false;
  return round.arbiters.some((a) => a.toLowerCase() === address.toLowerCase());
}

/** Whether the arbiter still owes a commit / reveal in the current phase. */
export function arbiterNeedsAction(
  round: RoundState | null,
  address: string | null | undefined,
  committed: string[],
  revealed: string[],
): "commit" | "reveal" | "wait" | "none" {
  if (!round || !isSelected(round, address)) return "none";
  const a = address!.toLowerCase();
  const hasCommitted = committed.map((x) => x.toLowerCase()).includes(a) || round.commitCount > 0;
  const hasRevealed = revealed.map((x) => x.toLowerCase()).includes(a);
  if (round.phase === "commit") return "commit";
  if (round.phase === "reveal" && !hasRevealed) return "reveal";
  void hasCommitted;
  return "wait";
}

/** Quorum met yet? */
export function quorumMet(round: RoundState | null): boolean {
  return !!round && round.revealCount >= QUORUM;
}

/**
 * Reads the escrow's static dispute windows (commit/reveal/appeal), in seconds.
 * Used for the finalize gate and copy. Chain reads are authoritative; on failure
 * (mock dev, offline) falls back to the /overview runtime mirrors so clocks
 * still render instead of collapsing to 0.
 */
export function useDisputeWindows(): { commit: number; reveal: number; appeal: number } {
  const escrow = useRuntime((s) => s.escrow);
  const fbCommit = useRuntime((s) => s.commitWindowSeconds);
  const fbReveal = useRuntime((s) => s.revealWindowSeconds);
  const fbAppeal = useRuntime((s) => s.appealWindowSeconds);
  const [chain, setChain] = useState<{ commit: number; reveal: number; appeal: number } | null>(null);
  useEffect(() => {
    if (!escrow) return;
    let cancelled = false;
    (async () => {
      const [c, r, a] = await Promise.all([
        readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "commitWindow" }).catch(() => null),
        readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "revealWindow" }).catch(() => null),
        readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "appealWindow" }).catch(() => null),
      ]);
      if (cancelled) return;
      if (c !== null || r !== null || a !== null) setChain({
        commit: Number(c ?? BigInt(fbCommit)),
        reveal: Number(r ?? BigInt(fbReveal)),
        appeal: Number(a ?? BigInt(fbAppeal)),
      });
    })();
    return () => { cancelled = true; };
  }, [escrow, fbCommit, fbReveal, fbAppeal]);
  return chain ?? { commit: fbCommit, reveal: fbReveal, appeal: fbAppeal };
}

/** A 1-second ticking clock; returns current unix seconds. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Polls the live round state for a dispute. Falls back to null (offline) if the
 * escrow address is unknown or the read fails.
 */
export function useRoundState(dispute: DisputeView | null | undefined, onchainId: number | null | undefined): RoundState | null {
  const escrow = useRuntime((s) => s.escrow);
  const [round, setRound] = useState<RoundState | null>(null);
  const roundIndex = dispute?.round ?? 0;

  useEffect(() => {
    if (!escrow || !dispute || onchainId == null) return;
    let cancelled = false;
    const load = async () => {
      const r = await fetchRound(escrow, BigInt(onchainId), roundIndex);
      if (!cancelled) setRound(r);
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [escrow, dispute, onchainId, roundIndex]);

  return round;
}

/** Human label for an outcome ordinal. */
export function outcomeLabel(o: number): string {
  return ["Release", "Refund", "Split 50/50"][o] ?? "—";
}
