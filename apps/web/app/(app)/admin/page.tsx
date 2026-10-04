"use client";

/** /admin — operator surface: reconciliation, fees, indexer health. */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/lib/wallet";
import { get, post, useInvalidate, useOverview } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useChainAction, withdrawFeesAction } from "@/lib/chain-actions";
import { ListHead, EthAmount, HashText, press, Skeleton, StatusBadge } from "@/components/design";
import { formatEth, timeAgo, toWei } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowsClockwise, CheckCircle, Coins, ShieldStar } from "@/components/icons";
interface ReconciliationRun {
  id: string;
  startedAt: string;
  drifts: number;
  report: { stats?: { corrected?: number }; solvency?: { ok: boolean; balanceWei: string; liabilitiesWei: string } } | null;
}

export default function AdminPage() {
  const session = useSession();
  const { address } = useWallet();
  const isAdmin = !!session.user?.isAdmin;
  const { data: overview } = useOverview();
  // Fee accrual is a SUM OVER EVENT HISTORY, not a field on a row. Asking the
  // ledger for `type: "FeeWithdrawn"` and then filtering that page for
  // MilestoneReleased/Split could only ever return [] — the card read a
  // permanent "0 ETH" and the fee-exit button below it was dead forever.
  // `/ledger/summary` is the endpoint that already totals it.
  const { data: feeSummary } = useQuery({
    queryKey: ["ledger-summary"],
    queryFn: () => get<{ fees: { accruedWei: string; withdrawnWei: string; pendingWei: string } }>("/ledger/summary"),
    enabled: isAdmin,
    refetchInterval: 15_000,
  });
  const [runs, setRuns] = useState<ReconciliationRun[] | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const chain = useChainAction();

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await get<ReconciliationRun[]>("/admin/reconciliations"));
    } catch {
      setRuns([]);
    }
  }, []);
  // Was a network call in the render body: it re-fired on every render while
  // `runs` was still null — and again under every 15s poll beneath it. Declared
  // above the non-admin early return, because hooks cannot be conditional.
  useEffect(() => {
    if (isAdmin) void loadRuns();
  }, [isAdmin, loadRuns]);

  if (!isAdmin) {
    return (
      <div className="space-y-10">
        <div>
          <h1 className="display text-[18px] leading-[1.5] md:text-[24px]">Platform controls.</h1>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
            Trust levers, intentionally admin-gated: mirror-vs-chain reconciliation with a live solvency check, fee
            exit, and the indexer checkpoint.
          </p>
        </div>
        {/* the console, gated: a dimmed preview of the bento behind a lock plate */}
        <div className="relative">
          <div aria-hidden className="grid gap-4 opacity-45 blur-[1.5px] md:grid-cols-5">
            <Skeleton className="h-60 md:col-span-3" />
            <Skeleton className="h-60 md:col-span-2" />
            <Skeleton className="h-28 md:col-span-5" />
          </div>
          <div className="absolute inset-0 grid place-items-center px-4">
            <div className="glass-raised flex max-w-md flex-col gap-2.5 px-6 py-5 text-center sm:flex-row sm:text-left">
              <div className="grid h-10 w-10 shrink-0 place-items-center self-center bg-rose-soft ring-1 ring-rose-accent/30">
                <ShieldStar weight="bold" className="h-5 w-5 text-rose-bright" />
              </div>
              <div>
                <div className="text-[15px] font-medium">Operator gate</div>
                <p className="mt-1 text-[14px] leading-relaxed text-faint">
                  Sign in with the operator wallet (ADMIN_WALLETS) to open
                  reconciliation runs, fee exit, and the solvency check.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function reconcile() {
    setReconciling(true);
    try {
      // `runReconciliation` returns { checked, drifts, report } — there is no
      // `repaired` field, so the toast used to read "undefined repaired". The
      // repaired count lives in the persisted run's report.stats.corrected.
      const result = await post<{ checked: number; drifts: number }>("/admin/reconcile");
      toast.success("Reconciliation complete", { description: `${result.checked} checked · ${result.drifts} drifts found` });
      await loadRuns();
    } catch (err) {
      toast.error("Reconciliation failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setReconciling(false);
    }
  }

  const accruedWei = toWei(feeSummary?.fees.accruedWei);
  const withdrawnWei = toWei(feeSummary?.fees.withdrawnWei);
  const pendingWei = toWei(feeSummary?.fees.pendingWei);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="display text-[18px] leading-[1.5] md:text-[24px]">Platform controls.</h1>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
          Trust levers, intentionally admin-gated: mirror-vs-chain reconciliation with a live solvency check, fee
          exit, and the indexer checkpoint.
        </p>
      </div>

      {/* asymmetric operator bento: manifest wide, fees beside, solvency below */}
      <div className="grid gap-4 md:grid-cols-5">
        {/* deployment manifest — hairline definition rows, copyable addresses */}
        <div className="glass p-6 md:col-span-3">
          <div className="num text-[13px] uppercase tracking-[0.16em] text-faint">deployment manifest</div>
          <dl className="mt-4 divide-y-2 divide-line">
            {[
              ["chain", `anvil · ${overview?.config.chainId ?? "…"}`],
              ["mode", overview?.config.chainMode ?? "…"],
              ["fee", overview?.config.feeBps != null ? `${(overview.config.feeBps / 100).toFixed(1)}% (${overview.config.feeBps} bps)` : "…"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-6 py-2.5">
                <dt className="text-[13px] text-faint">{k}</dt>
                <dd className="num text-right text-[14px] text-dim">{v}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-6 py-2.5">
              <dt className="text-[13px] text-faint">escrow</dt>
              <dd className="text-right"><HashText value={overview?.config.contracts.escrow ?? null} size={6} /></dd>
            </div>
            <div className="flex items-baseline justify-between gap-6 py-2.5">
              <dt className="text-[13px] text-faint">registry</dt>
              <dd className="text-right"><HashText value={overview?.config.contracts.arbiterRegistry ?? null} size={6} /></dd>
            </div>
          </dl>
        </div>

        <div className="glass flex flex-col p-6 md:col-span-2">
          <div className="num text-[13px] uppercase tracking-[0.16em] text-faint">fees accrued (mirror)</div>
          <EthAmount pixel wei={accruedWei} className="mt-4 block text-[22px] leading-none text-state-split" />
          <p className="mt-2 max-w-[56ch] text-[13px] leading-relaxed text-faint">
            The contract is the authority; this figure re-derives from ledger events.
            {withdrawnWei > 0n && <> {formatEth(withdrawnWei)} ETH already withdrawn.</>}
          </p>
          {/* A disabled control with no stated reason reads as broken. */}
          {!address && <p className="mt-2 text-[13px] text-state-funded">Connect the operator wallet to sign the withdrawal.</p>}
          {!!address && accruedWei === 0n && !chain.active && (
            <p className="mt-2 text-[13px] text-state-funded">Nothing accrued yet — fees appear when a milestone is released or split.</p>
          )}
          <Button variant="outline"
            disabled={chain.active || accruedWei === 0n || !address}
            onClick={async () => {
              const result = await withdrawFeesAction(chain.run)();
              if (result.ok) toast.success("Fees split 50/50 to treasury + sponsorship");
            }}
            className="mt-auto w-full"
          >
            <Coins className="h-5 w-5" /> Withdraw fees
          </Button>
          <p className="text-[13px] text-faint">withdrawFees() splits 50/50 to treasury + sponsorship.</p>
        </div>

        <div className="glass p-6 md:col-span-5">
          <div className="num text-[13px] uppercase tracking-[0.16em] text-faint">solvency check</div>
          {runs?.[0]?.report?.solvency ? (
            <div className="mt-4 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div className={`flex items-center gap-2 text-lg font-medium ${runs[0].report.solvency.ok ? "text-state-released" : "text-state-disputed"}`}>
                <CheckCircle weight="bold" className="h-5 w-5" />
                {runs[0].report.solvency.ok ? "balance ≥ liabilities" : "drift detected"}
              </div>
              {/* the balance sheet, stated as two figures with a verdict between */}
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                <span className="display text-[20px] leading-none">
                  {formatEth(runs[0].report.solvency.balanceWei)}
                  <span className="ml-1.5 text-xs text-faint">ETH held</span>
                </span>
                <span className="text-[13px] uppercase tracking-widest text-faint">vs</span>
                <span className="display text-[20px] leading-none text-dim">
                  {formatEth(runs[0].report.solvency.liabilitiesWei)}
                  <span className="ml-1.5 text-xs text-faint">ETH owed</span>
                </span>
              </div>
              <Button onClick={reconcile} disabled={reconciling}>
                <ArrowsClockwise className={`h-5 w-5 ${reconciling ? "animate-spin" : ""}`} />
                {reconciling ? "Reconciling…" : "Run reconciliation"}
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <p className="max-w-[52ch] text-[14px] leading-relaxed text-faint">
                {overview?.config.chainMode === "real"
                  ? "Run a reconciliation to verify escrow solvency against the chain — held balance vs unsettled milestones and accrued fees."
                  : "Solvency is a chain read, and this deployment is running in mock mode — it cannot be verified here. Boot the real chain to see the balance sheet."}
              </p>
              <Button onClick={reconcile} disabled={reconciling} className="shrink-0">
                <ArrowsClockwise className={`h-5 w-5 ${reconciling ? "animate-spin" : ""}`} />
                {reconciling ? "Reconciling…" : "Run reconciliation"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <section>
        <ListHead>Reconciliation runs</ListHead>
        <div className="mt-4 divide-y-2 divide-line overflow-hidden border-2 border-line">
          {(runs ?? []).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-1.5 bg-ink-raised px-6 py-4">
              <StatusBadge status={r.drifts === 0 ? "released" : "disputed"} pulse={false} />
              <span className="num text-[14px] text-dim">{r.drifts} drifts · {r.report?.stats?.corrected ?? 0} repaired</span>
              {r.report?.solvency && (
                <span className="num text-[13px] text-faint">
                  solvency {r.report.solvency.ok ? "ok" : "FAIL"} · {formatEth(r.report.solvency.balanceWei)} vs {formatEth(r.report.solvency.liabilitiesWei)}
                </span>
              )}
              <span className="num ml-auto text-[13px] text-faint">{timeAgo(r.startedAt)}</span>
            </div>
          ))}
          {runs && runs.length === 0 && <div className="px-6 py-5 text-sm text-faint">No runs yet.</div>}
        </div>
      </section>
    </div>
  );
}
