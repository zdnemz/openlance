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
  return "reveal"; // deadline passed but not yet tallied — still "reveal" (tally pending)
}

/* ── Chain gates ────────────────────────────────────────────────────────────
 * Every "may this seat do that" question the dispute UI asks, in one place,
 * each one a transcription of the Escrow check it stands for. The two surfaces
 * that render a round used to answer these inline, and had already drifted.
 *
 * The boundaries are deliberately off-by-one to match the contract, which
 * compares with `>` for a closed window and `<=` for an open one. Off-by-one
 * here is not cosmetic: `commitVote` and `revealVote` meet at exactly one
 * second, and a UI that closes the commit window early removes a legitimate
 * vote while a UI that opens the reveal window early reverts on every click.
 */

/** `Escrow.commitVote` reverts when `block.timestamp > commitDeadline`. */
export function commitWindowOpen(now: number, commitDeadline: number): boolean {
  return now <= commitDeadline;
}

/** `Escrow.revealVote` reverts unless `commitDeadline < now <= revealDeadline`. */
export function revealWindowOpen(now: number, commitDeadline: number, revealDeadline: number): boolean {
  return now > commitDeadline && now <= revealDeadline;
}

/** `Escrow.resolveDispute` reverts while the window is open and a vote is out. */
function tallyOpen(round: RoundState, now: number): boolean {
  if (round.resolved || round.arbiterCount === 0) return false;
  if (now > round.revealDeadline) return true;
  return round.revealCount >= round.arbiterCount; // early tally, once everyone revealed
}

/**
 * The reveal window is open, but only for an arbiter whose salt survived.
 *
 * The salt lives in this browser and nowhere else — the contract stores the
 * hash, never the outcome. So "I committed" is not the same as "I can
 * reveal": an arbiter who cleared storage, switched device, or opened a
 * private window holds a live commitment they can never satisfy, and the round
 * is one reveal short of quorum because of it. `hasSalt: false` is exactly
 * that case, and the UI has to say so rather than render a button that can
 * only revert.
 */
export function canReveal(v: { hasSalt: boolean; isSelected: boolean; myRevealed: boolean }): boolean {
  return v.isSelected && v.hasSalt && !v.myRevealed;
}

/**
 * `Escrow.finalizeDispute` reverts while the appeal window is open, and that
 * window is the one `Escrow.appeal` is gated on — so the two are exact
 * complements and a single deadline drives both. A surface that gates them
 * separately will eventually offer a party an appeal on a payout that already
 * moved.
 */
export function canFinalize(v: { resolved: boolean; appealEndsAt: number | null }, now: number): boolean {
  return v.resolved && v.appealEndsAt !== null && now > v.appealEndsAt;
}

/** Everything a dispute surface may offer, derived from the live round. */
export function roundGates(round: RoundState, now: number, appealWindow = 0) {
  // The appeal window runs from the reveal deadline, which is chain truth
  // (`getRound`). The only non-chain input is the window's LENGTH.
  const appealEndsAt = round.resolved ? round.revealDeadline + appealWindow : null;
  return {
    canCommit: !round.resolved && commitWindowOpen(now, round.commitDeadline),
    canReveal: !round.resolved && revealWindowOpen(now, round.commitDeadline, round.revealDeadline),
    canTally: tallyOpen(round, now),
    canFinalize: canFinalize({ resolved: round.resolved, appealEndsAt }, now),
    appealEndsAt,
    appealOpen: appealEndsAt !== null && now <= appealEndsAt,
  };
}

export async function fetchRound(escrow: string, milestoneId: bigint, round: number): Promise<RoundState | null> {
  const raw = await readContract<readonly unknown[]>({
    to: escrow,
    abi: ESCROW_ABI,
    functionName: "getRound",
    args: [milestoneId, round],
  });
  if (!raw) return null;
  const arbiterCount = Number(raw[1]);
  const commitDeadline = Number(raw[5] as bigint);
  const revealDeadline = Number(raw[6] as bigint);
  // getRound never reverts for a missing round — it returns the zero struct.
  // Without this guard an undisputed milestone looks like a tallyable round
  // (deadline 0 < now), and tallying reverts NotDisputed via the relay (500).
  if (arbiterCount === 0 && commitDeadline === 0 && revealDeadline === 0) return null;
  const arbiters = (raw[0] as string[]).slice(0, arbiterCount).filter((a) => a.toLowerCase() !== ZERO);
  const resolved = Boolean(raw[7]);
  return {
    arbiters,
    arbiterCount,
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
  const hasCommitted = committed.map((x) => x.toLowerCase()).includes(a);
  const hasRevealed = revealed.map((x) => x.toLowerCase()).includes(a);
  if (hasRevealed) return "wait";
  if (round.phase === "commit") return hasCommitted ? "wait" : "commit";
  if (round.phase === "reveal") {
    if (!hasCommitted) return "none";
    return "reveal";
  }
  return "wait";
}

/* ── Commit secret persistence (outcome + salt must match at reveal) ────── */
// ponytail: localStorage (bukan sessionStorage) agar survive pindah tab;
// masih per-device — sinkron lintas-device menyusul bila dibutuhkan.
export function commitKey(disputeId: string, round: number): string {
  return `commit:${disputeId}:${round}`;
}

export function saveCommit(disputeId: string, round: number, outcome: string, salt: `0x${string}`): void {
  try {
    localStorage.setItem(commitKey(disputeId, round), `${outcome}:${salt}`);
  } catch {
    try { sessionStorage.setItem(commitKey(disputeId, round), `${outcome}:${salt}`); } catch { /* noop */ }
  }
}

export function loadCommit(disputeId: string, round: number): { outcome: string; salt: `0x${string}` } | null {
  const read = (store: Storage | undefined): string | null => {
    try { return store?.getItem(commitKey(disputeId, round)) ?? null; } catch { return null; }
  };
  const saved = read(typeof localStorage !== "undefined" ? localStorage : undefined)
    ?? read(typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  if (!saved) return null;
  const [outcome, salt] = saved.split(":");
  if (!outcome || !salt) return null;
  return { outcome, salt: salt as `0x${string}` };
}

export function clearCommit(disputeId: string, round: number): void {
  try { localStorage.removeItem(commitKey(disputeId, round)); } catch { /* noop */ }
  try { sessionStorage.removeItem(commitKey(disputeId, round)); } catch { /* noop */ }
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
export interface RoundStateResult {
  /** The live round, or null when the chain genuinely has none for this index. */
  round: RoundState | null;
  /**
   * True once a read has actually completed. Before this — and forever after a
   * failed one — `round` is null for a reason that is NOT "no round exists", and
   * the caller must not claim the opening transaction is missing.
   */
  read: boolean;
}

export function useRoundState(dispute: DisputeView | null | undefined, onchainId: number | null | undefined): RoundStateResult {
  const escrow = useRuntime((s) => s.escrow);
  const [round, setRound] = useState<RoundState | null>(null);
  const [read, setRead] = useState(false);
  const roundIndex = dispute?.round ?? 0;

  useEffect(() => {
    if (!escrow || !dispute || onchainId == null) return;
    let cancelled = false;
    const load = async () => {
      const r = await fetchRound(escrow, BigInt(onchainId), roundIndex);
      if (cancelled) return;
      setRound(r);
      // Only a COMPLETED read counts — a relay that is down leaves `round` null
      // forever, and calling that "the opening tx never landed" is a lie.
      setRead(true);
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [escrow, dispute, onchainId, roundIndex]);

  return { round, read };
}

/** Human label for an outcome ordinal. */
export function outcomeLabel(o: number): string {
  return ["Release", "Refund", "Split 50/50"][o] ?? "—";
}
