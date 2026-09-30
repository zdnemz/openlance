"use client";

/**
 * Free job budget — the client's way back to whatever the locked ceiling did
 * not spend: an under-ceiling award whose automatic return was declined in the
 * wallet, a cancelled milestone, or a job cancelled before it was awarded.
 *
 * The amount is chain truth (locked − paidOut − reserved), never a mirror
 * number, and the withdrawal runs through the same sender as the award-time
 * automatic return — one place decides how much is owed back, so the button and
 * the automatic return can never disagree.
 *
 * Renders nothing when there is no free balance, so it costs an empty node in
 * the common case where the award already handed the surplus back.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EthAmount, ListHead } from "@/components/design";
import { Button } from "@/components/ui/button";
import { readJobBudget, returnBudgetSurplus } from "@/lib/chain-actions";
import { formatEth } from "@/lib/format";
import { useInvalidate } from "@/lib/queries";
import { useRuntime } from "@/lib/runtime";

export function SurplusPanel({ jobId, jobRef }: { jobId: string; jobRef: string }) {
  const escrow = useRuntime((s) => s.escrow);
  const chainId = useRuntime((s) => s.chainId);
  const invalidate = useInvalidate();
  const [free, setFree] = useState<bigint | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const loadFree = useCallback(async () => {
    if (!escrow) return setFree(null);
    setFree((await readJobBudget(escrow, jobRef).catch(() => null))?.free ?? null);
  }, [escrow, jobRef]);

  useEffect(() => {
    void loadFree();
    const t = setInterval(loadFree, 8000);
    return () => clearInterval(t);
  }, [loadFree]);

  async function withdraw() {
    if (!escrow || withdrawing) return;
    setWithdrawing(true);
    try {
      // `reason` carries the true cause out of the never-throwing withdrawal,
      // so a rejected signature is not reported as an empty balance.
      let reason: string | null = null;
      const back = await returnBudgetSurplus(escrow, jobRef, chainId, (m) => { reason = m; });
      if (back === 0n) throw new Error(reason ?? "Nothing to withdraw, or the withdrawal did not land");
      await loadFree();
      invalidate.job(jobId);
      toast.success("Surplus withdrawn", { description: `${formatEth(back.toString())} ETH back to your wallet.` });
    } catch (err) {
      toast.error("Could not withdraw", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setWithdrawing(false);
    }
  }

  if (!escrow || free === null || free <= 0n) return null;

  return (
    <section className="glass rounded-3xl p-6">
      <ListHead>Free budget</ListHead>
      <p className="mt-2.5 text-[13px] leading-relaxed text-dim">
        What the locked budget has left after the awarded milestones — an under-ceiling award hands its surplus back
        automatically, and this is the manual retry when that return was declined.
      </p>
      <div className="mt-4 flex items-center justify-between">
        <EthAmount wei={free.toString()} className="text-lg font-medium text-rose-bright" />
        <Button
          disabled={withdrawing}
          onClick={withdraw}
          className="rounded-full bg-white/10 px-5 py-2.5 text-[13px] font-medium hover:bg-white/20"
        >
          {withdrawing ? "Withdrawing…" : "Withdraw"}
        </Button>
      </div>
    </section>
  );
}
