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
import { sendContractCall, waitForReceipt } from "@/lib/wallet";
import { ESCROW_ABI, REGISTRY_ABI } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { get } from "@/lib/api";
import { toast } from "sonner";
import type { ProjectView } from "@/lib/types";
import { shortHash, toWei } from "@/lib/format";

export type Phase = "idle" | "signing" | "mining" | "indexing" | "done";

export function useChainAction() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const escrow = useRuntime((s) => s.escrow);
  const registry = useRuntime((s) => s.registry);
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
        const hash = await sendContractCall({
          to: address,
          abi: abi as never,
          functionName: opts.functionName,
          args: opts.args,
          value: opts.value,
        });
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
    [escrow, registry, qc],
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

/** Open a dispute: payable — the caller must send at least the dispute fee. */
export function openDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, feeWei: bigint, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Open dispute",
      contract: "escrow",
      functionName: "openDispute",
      args: [toWei(onchainId)],
      value: feeWei,
      projectId,
      expect,
      successMessage: "Dispute opened — arbiters being selected on-chain",
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
  return (to: string) =>
    run({
      label: "Withdraw accrued fees",
      contract: "escrow",
      functionName: "withdrawFees",
      args: [to],
      successMessage: "Fees withdrawn to the admin wallet",
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

/** Request to leave; benched from selection immediately. */
export function requestUnstakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Request unstake",
      contract: "registry",
      functionName: "requestUnstake",
      args: [],
      successMessage: "Unstake requested — you're out of the selection pool",
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

/** Withdraw collateral (only when idle and score healthy). */
export function withdrawStakeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return () =>
    run({
      label: "Withdraw stake",
      contract: "registry",
      functionName: "withdrawStake",
      args: [],
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
