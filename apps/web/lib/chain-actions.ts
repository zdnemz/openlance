"use client";

/**
 * Chain-action orchestration — the write path every money movement goes
 * through, with the honest three-phase UX the state split deserves:
 *
 *   1. SIGN      wallet signs the escrow call
 *   2. MINED     receipt seen through the relay
 *   3. MIRROR    indexer applies the event; the API view flips
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readContract, sendContractCall, waitForReceipt } from "@/lib/wallet";
import { relayForwardRequest } from "@/lib/sponsorship";
import { useSponsorship } from "@/lib/sponsorship-store";
import { ESCROW_ABI, REGISTRY_ABI } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { get } from "@/lib/api";
import { toast } from "sonner";
import type { ProjectView } from "@/lib/types";
import { formatEth, shortHash, toWei } from "@/lib/format";

/**
 * Live budget lock for a job (locked − paidOut − reserved = free). Null when
 * the reads are unavailable — callers then send optimistically and let the
 * contract decide, exactly as before.
 */
export async function readJobBudget(escrow: string, jobRef: string): Promise<{
  locked: bigint; reserved: bigint; paidOut: bigint; free: bigint;
} | null> {
  const [locked, reserved, paidOut] = await Promise.all([
    readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "lockedBudget", args: [jobRef] }),
    readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "reservedBudget", args: [jobRef] }),
    readContract<bigint>({ to: escrow, abi: ESCROW_ABI, functionName: "paidOutBudget", args: [jobRef] }),
  ]);
  if (locked === null || reserved === null || paidOut === null) return null;
  return { locked, reserved, paidOut, free: locked - paidOut - reserved };
}

/**
 * Hand back the job budget the winning bid never used.
 *
 * The client locked the FULL ceiling at publish, so an award below the ceiling
 * leaves a gap. `fundAllFromCredit` reserves exactly the bid, so the moment that
 * tx mines the job's free balance (locked − paidOut − reserved) IS ceiling −
 * bid, and `unlockBudget` returns it. Only the wallet that locked the budget may
 * call it, so this rides the client's own transaction — there is no server path.
 *
 * Best-effort by design: a reject or revert leaves the surplus LOCKED and
 * withdrawable, and every live milestone stays backed either way. Returns the
 * wei handed back (0n when there was nothing to return, or it did not land) and
 * never throws, so it can never fail an award that already happened. The
 * SurplusPanel button is the manual retry for the declined case.
 */
export async function returnBudgetSurplus(
  escrow: string,
  jobRef: string,
  chainId?: number,
): Promise<bigint> {
  try {
    // Re-read AFTER funding: reserved only equals the bid once the batch mined.
    const budget = await readJobBudget(escrow, jobRef);
    if (!budget || budget.free <= 0n) return 0n;
    const hash = await sendContractCall({
      to: escrow,
      abi: ESCROW_ABI,
      functionName: "unlockBudget",
      args: [jobRef, budget.free],
      expectedChainId: chainId,
    });
    return (await waitForReceipt(hash)).status === "success" ? budget.free : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Funding reverts speak in custom-error names (often inside a relay 500).
 * Translate the common ones into what the user should actually do.
 */
export function describeFundingRevert(message: string, totalWei: bigint, freeWei: bigint | null): string {
  if (/InsufficientBudget/i.test(message)) {
    if (freeWei === null) return "The job budget couldn't cover this funding batch — it may already be funded on-chain. Open the project room to check.";
    if (freeWei <= 0n) return "Already fully funded on-chain — nothing left to draw from the job budget.";
    return `Job budget too small: needs ${formatEth(totalWei)} ETH but only ${formatEth(freeWei)} ETH is free.`;
  }
  // fundAllFromCredit takes two shapes: the first call for a job carries the
  // value that becomes the lock (and must equal the batch), later calls must
  // send nothing. A mismatch between the two is the usual funding failure.
  if (/ValueMismatch/i.test(message)) return "The funding value didn't match the milestone total — refresh and retry; if the budget was already locked, the batch must carry no value.";
  if (/NoBudgetLocked/i.test(message)) return "No budget locked for this job on the current chain.";
  if (/NotClient/i.test(message)) return "Only the wallet that locked the job budget can fund from it — switch wallets and retry.";
  if (/BadBatch/i.test(message)) return "Funding batch malformed — refresh the page and try again.";
  return message;
}

export type Phase = "idle" | "signing" | "mining" | "indexing" | "done";

/**
 * Whether a call may take the gasless relay. The relayer sponsors STATE
 * CHANGES, never value movement — in either direction:
 *
 *   · A call that carries `value` may never be relayed. The forwarder pays
 *     `req.value` out of its OWN balance (SponsorshipForwarder.execute), so a
 *     relayed deposit moves the relayer's ETH while crediting the user's stake
 *     — a bare signature, no balance change, and a slashed bond that costs the
 *     platform instead of the arbiter. Funding, stake deposit/top-up and
 *     dispute fees are therefore normal user-paid transactions.
 *   · A call that moves value OUT declares `userPaid` — a withdrawal pays the
 *     user's own collateral back, and it should be a transaction they can see
 *     and pay for like every other money action, not a signature the relayer
 *     sponsors.
 *
 * Everything else is a bookkeeping action with no principal: submit, approve,
 * cancel, commit/reveal vote, tally, finalize, unstake request/cancel, fee
 * withdrawal. Those stay gasless.
 */
export function canRelayGasless(opts: { value?: bigint; userPaid?: boolean }): boolean {
  return !opts.userPaid && (opts.value ?? 0n) === 0n;
}

export function useChainAction() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const escrow = useRuntime((s) => s.escrow);
  const registry = useRuntime((s) => s.registry);
  const chainId = useRuntime((s) => s.chainId);
  const qc = useQueryClient();

  const reset = useCallback(() => {
    setPhase("idle");
    setTxHash(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (opts: {
      label: string;
      contract: "escrow" | "registry";
      functionName: string;
      args?: unknown[];
      value?: bigint;
      /** Force the user's own transaction (gas included) — see canRelayGasless. */
      userPaid?: boolean;
      projectId?: string;
      expect?: (p: ProjectView) => boolean;
      successMessage?: string;
    }): Promise<{ ok: boolean; hash: string | null }> => {
      const address = opts.contract === "escrow" ? escrow : registry;
      if (!address) {
        const msg = "Contract address unknown — API still syncing";
        setError(msg);
        toast.error(msg);
        return { ok: false, hash: null };
      }
      setError(null);
      setPhase("signing");
      try {
        const abi = opts.contract === "escrow" ? ESCROW_ABI : REGISTRY_ABI;
        // Gasless path: when a sponsorship session is active AND the call is one
        // the relayer may sponsor, the user signs an EIP-712 ForwardRequest and
        // the relayer pays the gas. Falls back to a normal user-paid call if
        // sponsorship is unavailable. `canRelayGasless` is the whole rule: a call
        // that moves value in (via `value`) or out (via `userPaid`) is always a
        // user transaction, so the wallet shows the amount and the balance moves.
        const sponsored = canRelayGasless(opts) && useSponsorship.getState().isActive();
        let hash: string;
        if (sponsored) {
          try {
            hash = await relayForwardRequest({
              to: address,
              abi: abi as never,
              functionName: opts.functionName,
              args: opts.args,
              value: opts.value,
            });
          } catch (relayErr) {
            // Session lapsed / relayer hiccup → transparent user-paid fallback.
            if (!useSponsorship.getState().isActive()) {
              hash = await sendContractCall({
                to: address,
                abi: abi as never,
                functionName: opts.functionName,
                args: opts.args,
                value: opts.value,
                expectedChainId: chainId,
              });
            } else {
              throw relayErr;
            }
          }
        } else {
          hash = await sendContractCall({
            to: address,
            abi: abi as never,
            functionName: opts.functionName,
            args: opts.args,
            value: opts.value,
            expectedChainId: chainId,
          });
        }
        setTxHash(hash);
        setPhase("mining");
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");

        if (opts.projectId && opts.expect) {
          setPhase("indexing");
          const started = Date.now();
          for (;;) {
            await new Promise((r) => setTimeout(r, 1100));
            await qc.invalidateQueries({ queryKey: ["project", opts.projectId] });
            let view: ProjectView | undefined;
            try {
              view = await get<ProjectView>(`/projects/${opts.projectId}`);
            } catch {
              /* transient */
            }
            if (view && opts.expect(view)) break;
            if (Date.now() - started > 45_000) break; // mirror lagged — UI keeps polling anyway
          }
        } else {
          await new Promise((r) => setTimeout(r, 1600));
        }
        setPhase("done");
        if (opts.successMessage) toast.success(opts.successMessage, { description: `tx ${shortHash(hash)}` });
        return { ok: true, hash };
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Chain action failed";
        const message = /reject|denied/i.test(raw) ? "Request rejected in wallet" : raw;
        setError(message);
        setPhase("idle");
        if (!/rejected/i.test(message)) toast.error(message);
        return { ok: false, hash: null };
      }
    },
    [escrow, registry, chainId, qc],
  );

  return { phase, txHash, error, run, reset };
}

/* ── Named actions (typed args, single source of truth per call) ────────── */

export function fundMilestoneAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (ref: string, freelancer: string, amountWei: string, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Fund milestone",
      contract: "escrow",
      functionName: "fund",
      args: [ref, freelancer],
      value: toWei(amountWei),
      projectId,
      expect,
      successMessage: "Milestone funded — value locked in escrow",
    });
}

export function submitMilestoneAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Submit milestone",
      contract: "escrow",
      functionName: "submit",
      args: [toWei(onchainId)],
      projectId,
      expect,
      successMessage: "Submitted on-chain — client review window open",
    });
}

export function approveMilestoneAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Approve + release",
      contract: "escrow",
      functionName: "approve",
      args: [toWei(onchainId)],
      projectId,
      expect,
      successMessage: "Released — funds paid out, fee accounted",
    });
}

export function cancelMilestoneAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Cancel milestone",
      contract: "escrow",
      functionName: "cancel",
      args: [toWei(onchainId)],
      projectId,
      expect,
      successMessage: "Cancelled — full refund issued",
    });
}

/* ── Multi-arbiter dispute lifecycle ────────────────────────────────────── */

/** Open a dispute: payable — the caller must send at least the dispute fee.
 * Pass the project's locked seats (zero-padded to 3) to seat exactly that panel
 * via `openDisputeWith`; omit for a fully random draw. The panel is binding —
 * an arbiter outside it is never seated — and a panel with no eligible member
 * left falls back to random on-chain, so a stale pick can never brick opening. */
export function openDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (
    onchainId: number, feeWei: bigint, projectId: string, expect: (p: ProjectView) => boolean,
    preferred?: readonly [string, string, string] | null,
  ) =>
    run({
      label: "Open dispute",
      contract: "escrow",
      functionName: preferred ? "openDisputeWith" : "openDispute",
      args: preferred ? [toWei(onchainId), [...preferred]] : [toWei(onchainId)],
      value: feeWei,
      projectId,
      expect,
      successMessage: preferred
        ? "Dispute opened — your locked arbiters are the panel"
        : "Dispute opened — arbiters selected on-chain",
    });
}

/** Commit a hidden vote: keccak256 of (outcome, salt, arbiter, milestoneId, round). */
export function commitVoteAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, round: number, commitHash: `0x${string}`, projectId?: string, expect?: (p: ProjectView) => boolean) =>
    run({
      label: "Commit vote",
      contract: "escrow",
      functionName: "commitVote",
      args: [toWei(onchainId), round, commitHash],
      projectId,
      expect,
      successMessage: "Vote committed — your choice is hidden until the reveal phase",
    });
}

/** Reveal a committed vote. */
export function revealVoteAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, round: number, outcome: number, salt: `0x${string}`, projectId?: string, expect?: (p: ProjectView) => boolean) =>
    run({
      label: "Reveal vote",
      contract: "escrow",
      functionName: "revealVote",
      args: [toWei(onchainId), round, outcome, salt],
      projectId,
      expect,
      successMessage: "Vote revealed — tally will run at the deadline",
    });
}

/** Tally the round (records the majority; payout follows finalize). */
export function tallyDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, round: number, projectId?: string, expect?: (p: ProjectView) => boolean) =>
    run({
      label: "Tally dispute",
      contract: "escrow",
      functionName: round === 0 ? "resolveDispute" : "resolveAppeal",
      args: [toWei(onchainId)],
      projectId,
      expect,
      successMessage: "Round tallied — majority recorded",
    });
}

/** Finalize the decision after the appeal window (executes the payout). */
export function finalizeDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Finalize dispute",
      contract: "escrow",
      functionName: "finalizeDispute",
      args: [toWei(onchainId)],
      projectId,
      expect,
      successMessage: "Dispute finalized — funds settled on-chain",
    });
}

/** Appeal a tallied decision (payable: another dispute fee). */
export function appealDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, feeWei: bigint, projectId: string, expect?: (p: ProjectView) => boolean) =>
    run({
      label: "Appeal dispute",
      contract: "escrow",
      functionName: "appeal",
      args: [toWei(onchainId)],
      value: feeWei,
      projectId,
      expect,
      successMessage: "Appeal opened — a fresh arbiter round begins",
    });
}

export function withdrawFeesAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Withdraw accrued fees",
      contract: "escrow",
      functionName: "withdrawFees",
      args: [],
      successMessage: "Fees split 50/50 to treasury + sponsorship",
    });
}

/* ── Arbiter staking ────────────────────────────────────────────────────── */

/** Self-register as an arbiter by depositing at least the minimum stake. */
export function registerArbiterWithStakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (stakeWei: bigint) =>
    run({
      label: "Register as arbiter",
      contract: "registry",
      functionName: "registerArbiter",
      args: [],
      value: stakeWei,
      successMessage: "Registered — SBT badge minted, you're in the selection pool",
    });
}

/** Top up collateral. */
export function addStakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (amountWei: bigint) =>
    run({
      label: "Add stake",
      contract: "registry",
      functionName: "addStake",
      args: [],
      value: amountWei,
      successMessage: "Stake topped up",
    });
}

/** Partial exit: pull out collateral while staying on the roster. */
export function reduceStakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (amountWei: bigint) =>
    run({
      label: "Reduce stake",
      contract: "registry",
      functionName: "reduceStake",
      args: [amountWei],
      successMessage: "Stake reduced — remainder keeps working",
    });
}

/** Request to leave; benched from selection immediately, withdrawable at once. */
export function requestUnstakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Request unstake",
      contract: "registry",
      functionName: "requestUnstake",
      args: [],
      successMessage: "Unstake requested — withdraw your collateral anytime",
    });
}

/** Cancel a pending unstake and rejoin the pool. */
export function cancelUnstakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Cancel unstake",
      contract: "registry",
      functionName: "cancelUnstake",
      args: [],
      successMessage: "Unstake cancelled — back in the selection pool",
    });
}

/**
 * Withdraw collateral (only when idle and score healthy).
 *
 * `userPaid`: a withdrawal moves value OUT of the protocol — the arbiter's own
 * stake comes back to them. It is a money action the user should see and pay
 * for like their deposit, not a signature the relayer sponsors. (The funds can
 * only ever go to `req.from`, so relaying it was never a drain risk — this is
 * about the money path being uniform, not about safety.)
 */
export function withdrawStakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Withdraw stake",
      contract: "registry",
      functionName: "withdrawStake",
      args: [],
      userPaid: true,
      successMessage: "Stake withdrawn",
    });
}

/** Admin-vetted registration of another arbiter (owner = timelock in prod). */
export function registerArbiterAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (arbiter: string, stakeWei: bigint) =>
    run({
      label: "Register arbiter",
      contract: "registry",
      functionName: "register",
      args: [arbiter],
      value: stakeWei,
      successMessage: "Arbiter registered with stake",
    });
}
