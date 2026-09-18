"use client";

/** /admin — operator surface: reconciliation, fees, indexer health. */
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { get, post, useInvalidate, useOverview, useLedger } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useChainAction, withdrawFeesAction } from "@/lib/chain-actions";
import { SectionLabel, EmptyState, EthAmount, HashText, press, StatusBadge } from "@/components/design";
import { formatEth, timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ShieldStar } from "@phosphor-icons/react/dist/csr/ShieldStar";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";

interface ReconciliationRun {
  id: string;
  startedAt: string;
  drifts: number;
  repaired: number;
  report: { solvency?: { ok: boolean; balanceWei: string; liabilitiesWei: string } } | null;
}

export default function AdminPage() {
  const session = useSession();
  const { address } = useWallet();
  const isAdmin = session.user?.walletAddress === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const { data: overview } = useOverview();
  const { data: ledger } = useLedger({ type: "FeeWithdrawn", limit: "10" });
  const [runs, setRuns] = useState<ReconciliationRun[] | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const chain = useChainAction();

  if (!isAdmin) {
    return (
      <EmptyState
        className="mt-16"
        icon={<ShieldStar className="h-5 w-5" />}
        title="Admin surface"
        body="Sign in with the admin wallet (devnet persona Mara Voss — anvil #0, the deployer) to see reconciliation runs, fee accounting, and indexer controls."
      />
    );
  }

  async function loadRuns() {
    try {
      setRuns(await get<ReconciliationRun[]>("/admin/reconciliations"));
    } catch {
      setRuns([]);
    }
  }
  if (runs === null) void loadRuns();

  async function reconcile() {
    setReconciling(true);
    try {
      const result = await post<{ drifts: number; repaired: number }>("/admin/reconcile");
      toast.success("Reconciliation complete", { description: `${result.drifts} drifts found · ${result.repaired} repaired` });
      await loadRuns();
    } catch (err) {
      toast.error("Reconciliation failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setReconciling(false);
    }
  }

  const feeEvents = (ledger?.items ?? []).filter((e) => e.eventType === "MilestoneReleased" || e.eventType === "MilestoneSplit");
  const withdrawnEvents = (ledger?.items ?? []);
  void withdrawnEvents;
  const accruedWei = feeEvents.reduce((acc, e) => acc + BigInt(String((e.payload as Record<string, string>).fee ?? "0")), 0n);

  return (
    <div className="space-y-10">
      <div>
        <SectionLabel>admin</SectionLabel>
        <h1 className="mt-2.5 text-3xl font-semibold tracking-tighter md:text-4xl">Platform controls.</h1>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
          Trust levers, intentionally admin-gated: mirror-vs-chain reconciliation with a live solvency check, fee
          exit, and the indexer checkpoint.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="glass rounded-3xl p-6">
          <div className="num text-[10px] uppercase tracking-[0.16em] text-faint">chain mode</div>
          <div className="num mt-2 text-lg font-medium">{overview?.config.chainMode ?? "…"}</div>
          <div className="num mt-1 text-[11px] text-faint">
            chain {overview?.config.chainId} · fee {((overview?.config.feeBps ?? 0) / 100).toFixed(1)}%
          </div>
          <div className="num mt-3 truncate text-[10.5px] text-faint">escrow {overview?.config.contracts.escrow?.slice(0, 14)}…</div>
          <div className="num truncate text-[10.5px] text-faint">registry {overview?.config.contracts.arbiterRegistry?.slice(0, 14)}…</div>
        </div>

        <div className="glass rounded-3xl p-6">
          <div className="num text-[10px] uppercase tracking-[0.16em] text-faint">fees accrued (mirror)</div>
          <EthAmount wei={accruedWei} className="mt-2 block text-xl font-medium text-state-split" />
          <Button
            disabled={chain.phase !== "idle" && chain.phase !== "done" || accruedWei === 0n || !address}
            onClick={async () => {
              const result = await withdrawFeesAction(chain.run)(address!);
              if (result.ok) toast.success("Fees withdrawn");
            }}
            className="mt-4 w-full rounded-full bg-white/10 py-2.5 text-[12.5px] hover:bg-white/20"
          >
            <Coins className="mr-2 h-3.5 w-3.5" /> withdrawFees → admin wallet
          </Button>
          <p className="mt-2.5 text-[10.5px] leading-relaxed text-faint">
            The contract is the authority; this figure re-derives from ledger events.
          </p>
        </div>

        <div className="glass rounded-3xl p-6">
          <div className="num text-[10px] uppercase tracking-[0.16em] text-faint">solvency check</div>
          {runs?.[0]?.report?.solvency ? (
            <>
              <div className={`mt-2 flex items-center gap-2 text-lg font-medium ${runs[0].report.solvency.ok ? "text-state-released" : "text-state-disputed"}`}>
                <CheckCircle weight="bold" className="h-5 w-5" />
                {runs[0].report.solvency.ok ? "balance ≥ liabilities" : "drift detected"}
              </div>
              <div className="num mt-1.5 text-[11px] leading-relaxed text-faint">
                balance {formatEth(runs[0].report.solvency.balanceWei)} ETH
                <br />
                unsettled + fees {formatEth(runs[0].report.solvency.liabilitiesWei)} ETH
              </div>
            </>
          ) : (
            <p className="mt-2 text-[12px] text-faint">Run a reconciliation to check escrow solvency against the chain.</p>
          )}
          <Button onClick={reconcile} disabled={reconciling} className="mt-4 w-full rounded-full bg-rose-accent py-2.5 text-[12.5px] font-medium text-white hover:bg-rose-bright">
            <ArrowsClockwise className={`mr-2 h-3.5 w-3.5 ${reconciling ? "animate-spin" : ""}`} />
            {reconciling ? "Reconciling…" : "Run reconciliation"}
          </Button>
        </div>
      </div>

      <section>
        <SectionLabel>reconciliation runs</SectionLabel>
        <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
          {(runs ?? []).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-1.5 bg-white/[0.012] px-6 py-4">
              <StatusBadge status={r.drifts === 0 ? "released" : "disputed"} pulse={false} />
              <span className="num text-[12.5px] text-dim">{r.drifts} drifts · {r.repaired} repaired</span>
              {r.report?.solvency && (
                <span className="num text-[11px] text-faint">
                  solvency {r.report.solvency.ok ? "ok" : "FAIL"} · {formatEth(r.report.solvency.balanceWei)} vs {formatEth(r.report.solvency.liabilitiesWei)}
                </span>
              )}
              <span className="num ml-auto text-[11px] text-faint">{timeAgo(r.startedAt)}</span>
            </div>
          ))}
          {runs && runs.length === 0 && <div className="px-6 py-5 text-sm text-faint">No runs yet.</div>}
        </div>
      </section>
    </div>
  );
}
