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
import { ESCROW_ABI, REGISTRY_ABI, DISPUTE_OUTCOME } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { get } from "@/lib/api";
import { toast } from "sonner";
import type { ProjectView } from "@/lib/types";
import { shortHash } from "@/lib/format";

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
      value: BigInt(amountWei),
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
      args: [BigInt(onchainId)],
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
      args: [BigInt(onchainId)],
      projectId,
      expect,
      successMessage: "Released — funds paid out, fee accounted",
    });
}

export function openDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Open dispute",
      contract: "escrow",
      functionName: "openDispute",
      args: [BigInt(onchainId)],
      projectId,
      expect,
      successMessage: "Dispute locked on-chain — arbiter selection open",
    });
}

export function nominateArbiterAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, candidate: string, projectId: string, expect?: (p: ProjectView) => boolean) =>
    run({
      label: "Nominate arbiter",
      contract: "escrow",
      functionName: "nominateArbiter",
      args: [BigInt(onchainId), candidate],
      projectId,
      expect,
      successMessage: "Nomination recorded on-chain",
    });
}

export function resolveDisputeAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (onchainId: number, outcome: keyof typeof DISPUTE_OUTCOME, projectId: string, expect: (p: ProjectView) => boolean) =>
    run({
      label: "Resolve dispute",
      contract: "escrow",
      functionName: "resolveDispute",
      args: [BigInt(onchainId), DISPUTE_OUTCOME[outcome]],
      projectId,
      expect,
      successMessage: `Dispute resolved — ${outcome} executed on-chain`,
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

export function registerArbiterAction(run: ReturnType<typeof useChainAction>["run"]) {
  return (arbiter: string) =>
    run({
      label: "Register arbiter",
      contract: "registry",
      functionName: "register",
      args: [arbiter],
      successMessage: "Arbiter registered — SBT badge will mint on first resolution",
    });
}
