"use client";

/** /admin — operator surface: reconciliation, fees, indexer health. */
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { get, post, useInvalidate, useOverview, useLedger } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useChainAction, withdrawFeesAction } from "@/lib/chain-actions";
import { ListHead, EthAmount, HashText, press, Skeleton, StatusBadge } from "@/components/design";
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
      <div className="space-y-10">
        <div>
          <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">Platform controls.</h1>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
            Trust levers, intentionally admin-gated: mirror-vs-chain reconciliation with a live solvency check, fee
            exit, and the indexer checkpoint.
          </p>
        </div>
        {/* the console, gated: a dimmed preview of the bento behind a lock plate */}
        <div className="relative">
          <div aria-hidden className="grid gap-4 opacity-45 blur-[1.5px] md:grid-cols-5">
            <Skeleton className="h-60 rounded-3xl md:col-span-3" />
            <Skeleton className="h-60 rounded-3xl md:col-span-2" />
            <Skeleton className="h-28 rounded-3xl md:col-span-5" />
          </div>
          <div className="absolute inset-0 grid place-items-center px-4">
            <div className="glass-raised flex max-w-md flex-col gap-2.5 rounded-2xl px-6 py-5 text-center sm:flex-row sm:text-left">
              <div className="grid h-10 w-10 shrink-0 place-items-center self-center rounded-xl bg-rose-soft ring-1 ring-rose-accent/30">
                <ShieldStar weight="bold" className="h-5 w-5 text-rose-bright" />
              </div>
              <div>
                <div className="text-[14px] font-medium">Operator gate</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-faint">
                  Sign in as devnet persona <span className="text-dim">Mara Voss</span> — anvil #0, the deployer — to open
                  reconciliation runs, fee exit, and the solvency check.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
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
        <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">Platform controls.</h1>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
          Trust levers, intentionally admin-gated: mirror-vs-chain reconciliation with a live solvency check, fee
          exit, and the indexer checkpoint.
        </p>
      </div>

      {/* asymmetric operator bento: manifest wide, fees beside, solvency below */}
      <div className="grid gap-4 md:grid-cols-5">
        {/* deployment manifest — hairline definition rows, copyable addresses */}
        <div className="glass rounded-3xl p-6 md:col-span-3">
          <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">deployment manifest</div>
          <dl className="mt-4 divide-y divide-white/[0.06]">
            {[
              ["chain", `anvil · ${overview?.config.chainId ?? "…"}`],
              ["mode", overview?.config.chainMode ?? "…"],
              ["fee", `${((overview?.config.feeBps ?? 0) / 100).toFixed(1)}% (${overview?.config.feeBps ?? "…"} bps)`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-6 py-2.5">
                <dt className="text-[12px] text-faint">{k}</dt>
                <dd className="num text-right text-[12.5px] text-dim">{v}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-6 py-2.5">
              <dt className="text-[12px] text-faint">escrow</dt>
              <dd className="text-right"><HashText value={overview?.config.contracts.escrow ?? null} size={6} /></dd>
            </div>
            <div className="flex items-baseline justify-between gap-6 py-2.5">
              <dt className="text-[12px] text-faint">registry</dt>
              <dd className="text-right"><HashText value={overview?.config.contracts.arbiterRegistry ?? null} size={6} /></dd>
            </div>
          </dl>
        </div>

        <div className="glass flex flex-col rounded-3xl p-6 md:col-span-2">
          <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">fees accrued (mirror)</div>
          <EthAmount wei={accruedWei} className="mt-3 block text-3xl font-medium tracking-tight text-state-split" />
          <p className="mt-2 max-w-[56ch] text-[12px] leading-relaxed text-faint">
            The contract is the authority; this figure re-derives from ledger events.
          </p>
          <Button
            disabled={chain.phase !== "idle" && chain.phase !== "done" || accruedWei === 0n || !address}
            onClick={async () => {
              const result = await withdrawFeesAction(chain.run)(address!);
              if (result.ok) toast.success("Fees withdrawn");
            }}
            className="mt-auto w-full rounded-full bg-white/10 py-2.5 text-[12.5px] hover:bg-white/20"
          >
            <Coins className="mr-2 h-3.5 w-3.5" /> withdrawFees → admin wallet
          </Button>
        </div>

        <div className="glass rounded-3xl p-6 md:col-span-5">
          <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">solvency check</div>
          {runs?.[0]?.report?.solvency ? (
            <div className="mt-4 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div className={`flex items-center gap-2 text-lg font-medium ${runs[0].report.solvency.ok ? "text-state-released" : "text-state-disputed"}`}>
                <CheckCircle weight="bold" className="h-5 w-5" />
                {runs[0].report.solvency.ok ? "balance ≥ liabilities" : "drift detected"}
              </div>
              {/* the balance sheet, stated as two figures with a verdict between */}
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                <span className="num text-2xl font-medium tracking-tight">
                  {formatEth(runs[0].report.solvency.balanceWei)}
                  <span className="ml-1.5 text-xs text-faint">ETH held</span>
                </span>
                <span className="text-[11px] uppercase tracking-widest text-faint">vs</span>
                <span className="num text-2xl font-medium tracking-tight text-dim">
                  {formatEth(runs[0].report.solvency.liabilitiesWei)}
                  <span className="ml-1.5 text-xs text-faint">ETH owed</span>
                </span>
              </div>
              <Button onClick={reconcile} disabled={reconciling} className="rounded-full bg-rose-accent px-6 py-2.5 text-[12.5px] font-medium text-white hover:bg-rose-bright">
                <ArrowsClockwise className={`mr-2 h-3.5 w-3.5 ${reconciling ? "animate-spin" : ""}`} />
                {reconciling ? "Reconciling…" : "Run reconciliation"}
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <p className="max-w-[52ch] text-[12.5px] leading-relaxed text-faint">
                Run a reconciliation to verify escrow solvency against the chain — held balance vs unsettled milestones and accrued fees.
              </p>
              <Button onClick={reconcile} disabled={reconciling} className="shrink-0 rounded-full bg-rose-accent px-6 py-2.5 text-[12.5px] font-medium text-white hover:bg-rose-bright">
                <ArrowsClockwise className={`mr-2 h-3.5 w-3.5 ${reconciling ? "animate-spin" : ""}`} />
                {reconciling ? "Reconciling…" : "Run reconciliation"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <section>
        <ListHead>Reconciliation runs</ListHead>
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
