"use client";

/**
 * Arbiter bubble + detail dialog.
 *
 * A picked/pending arbiter renders as a compact bubble (avatar + short address).
 * Clicking it opens a detail dialog with the public reputation record — trust
 * score, tier, stake, resolution history — plus a footer of contextual actions
 * (Approve & lock / Reject while a proposal is pending on the counterparty's
 * side; nothing to act on once locked). The full profile stays one click away.
 */
import { useState } from "react";
import Link from "next/link";
import { useArbiters } from "@/lib/queries";
import { useRuntime } from "@/lib/runtime";
import { AddressAvatar, Skeleton } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { formatEth, shortAddress } from "@/lib/format";
import { TIER_NAMES } from "@/lib/roles";
import type { ArbiterView } from "@/lib/types";

export type ArbiterActions = {
  busy?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
};

/** A compact, clickable arbiter chip. */
export function ArbiterBubble({
  address,
  onClick,
  tone = "dim",
}: {
  address: string;
  onClick: () => void;
  tone?: "dim" | "locked";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={address}
      className={`group flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[12.5px] transition-colors ${
        tone === "locked"
          ? "border-state-released/30 bg-state-released/[0.06] hover:border-state-released/60"
          : "border-line bg-white/[0.03] hover:border-rose-accent/50"
      }`}
    >
      <AddressAvatar address={address} size={22} />
      <span className="num text-dim transition-colors group-hover:text-foreground">{shortAddress(address)}</span>
      {tone === "locked" && <SealCheck weight="fill" className="h-3.5 w-3.5 text-state-released" />}
    </button>
  );
}

/** Renders a set of arbiters as bubbles; owns the shared detail dialog. */
export function ArbiterBubbles({
  addresses,
  tone = "dim",
  actions,
}: {
  addresses: string[];
  tone?: "dim" | "locked";
  actions?: ArbiterActions;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!addresses.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {addresses.map((a) => (
        <ArbiterBubble key={a} address={a} tone={tone} onClick={() => setOpen(a)} />
      ))}
      <ArbiterDetailDialog
        address={open}
        open={!!open}
        onOpenChange={(o) => { if (!o) setOpen(null); }}
        actions={actions}
      />
    </div>
  );
}

export function ArbiterDetailDialog({
  address,
  open,
  onOpenChange,
  actions = {},
}: {
  address: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ArbiterActions;
}) {
  const { data: arbiters, isLoading } = useArbiters();
  const minStakeWei = useRuntime((s) => s.minStakeWei);
  const arbiter = address ? (arbiters ?? []).find((a) => a.address.toLowerCase() === address.toLowerCase()) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
        <DialogHeader className="space-y-1.5 px-7 pb-4 pt-7">
          <DialogTitle className="flex items-center gap-2 text-xl tracking-tight">
            <Scales className="h-5 w-5 text-dim" /> Arbiter
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 px-7 pb-6">
            <Skeleton className="h-14 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ) : (
          <div className="px-7 pb-6">
            <div className="flex items-center gap-3.5">
              <AddressAvatar address={address ?? ""} size={46} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[16px] font-medium">
                    {arbiter?.profile?.displayName ?? shortAddress(address ?? "")}
                  </span>
                  {arbiter?.registered && <SealCheck weight="fill" className="h-4 w-4 shrink-0 text-rose-bright" />}
                </div>
                <Link
                  href={`/profile/${address}`}
                  className="num mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-faint transition-colors hover:text-rose-bright"
                >
                  full profile <ArrowSquareOut className="h-3 w-3" />
                </Link>
              </div>
            </div>

            {arbiter ? (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Stat label="trust score" value={String(arbiter.trustScore)} accent={arbiter.trustScore > 0} />
                  <Stat label="tier" value={(TIER_NAMES[arbiter.tier ?? 0] ?? "unstaked").toLowerCase()} />
                  <Stat label="stake" value={`${formatEth(arbiter.stakeWei)} ETH`} />
                  <Stat label="earned" value={`${formatEth(arbiter.totalEarnedWei)} ETH`} />
                  <Stat label="resolved" value={String(arbiter.resolutions)} />
                  <Stat label="standing" value={standingLabel(arbiter, minStakeWei)} />
                </div>
                {arbiter.kycStatus && arbiter.kycStatus !== "verified" && (
                  <p className="mt-3 text-[12px] text-amber-300">KYC {arbiter.kycStatus}</p>
                )}
              </>
            ) : (
              <p className="mt-5 text-[12.5px] text-faint">
                Not in the current registry roster — this address may have deregistered since it was proposed. It will
                fall back to random selection if it is no longer eligible.
              </p>
            )}

            {arbiter && (
              <p className="mt-4 text-[12px] leading-relaxed text-faint">
                Seats first if a milestone ever disputes; an ineligible entry silently falls back to the random draw.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="flex-col items-stretch gap-2.5 border-t border-line px-7 py-5 sm:flex-col sm:items-stretch">
          {(actions.onApprove || actions.onReject) ? (
            <div className="flex gap-2.5">
              {actions.onReject && (
                <Button
                  type="button"
                  disabled={actions.busy}
                  onClick={actions.onReject}
                  className="flex-1 rounded-full border border-line bg-transparent py-3 text-[13px] font-medium text-dim hover:border-destructive/50 hover:text-destructive"
                >
                  Reject
                </Button>
              )}
              {actions.onApprove && (
                <Button
                  type="button"
                  disabled={actions.busy}
                  onClick={actions.onApprove}
                  className="flex-1 rounded-full bg-state-released py-3 text-[13px] font-medium text-ink hover:brightness-110"
                >
                  {actions.busy ? "Locking…" : "Approve & lock"}
                </Button>
              )}
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full rounded-full bg-white/10 py-3 text-[13px] font-medium hover:bg-white/20"
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] px-4 py-3">
      <div className={`num text-lg font-medium leading-none ${accent ? "text-state-released" : "text-foreground"}`}>{value}</div>
      <div className="mt-1.5 text-[10.5px] uppercase tracking-[0.14em] text-faint">{label}</div>
    </div>
  );
}

function standingLabel(a: ArbiterView, minStakeWei: string): string {
  if (a.locked) return "locked";
  if (a.unstakeRequested) return "unstaking";
  if (a.eligible) return "eligible";
  try {
    if (BigInt(a.stakeWei || "0") < BigInt(minStakeWei || "0")) return "understake";
  } catch { /* malformed wei → fall through */ }
  return "staked";
}
