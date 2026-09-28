"use client";

/**
 * Arbiter picker dialog — every registered arbiter in one modal, with up to 3
 * eligible seats selectable. Rows link out to the arbiter's public profile so a
 * poster/freelancer can vet the record before proposing. Anchored off the
 * /arbiters roster (useArbiters) so the modal can never drift from the registry.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useArbiters } from "@/lib/queries";
import { useRuntime } from "@/lib/runtime";
import { AddressAvatar, ArbiterRegistrySkeleton, EmptyState } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { formatEth, shortAddress } from "@/lib/format";
import { TIER_NAMES } from "@/lib/roles";
import type { ArbiterView } from "@/lib/types";

const MAX_ARBITERS = 3;

export function ArbiterPickerDialog({
  open,
  onOpenChange,
  onConfirm,
  initial = [],
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (addresses: string[]) => void;
  initial?: string[];
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-raised max-w-2xl gap-0 rounded-3xl border-line p-0">
        {/* Body mounts fresh on every open (Radix unmounts content when closed),
            so `selected` always seeds from the current proposal. */}
        <ArbiterPickerBody initial={initial} busy={busy} onConfirm={onConfirm} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ArbiterPickerBody({
  initial,
  busy,
  onConfirm,
  onCancel,
}: {
  initial: string[];
  busy: boolean;
  onConfirm: (addresses: string[]) => void;
  onCancel: () => void;
}) {
  const { data: arbiters, isLoading } = useArbiters();
  const minStakeWei = useRuntime((s) => s.minStakeWei);
  const [selected, setSelected] = useState<string[]>(initial);

  const registered = useMemo(() => (arbiters ?? []).filter((a) => a.registered), [arbiters]);
  const ranked = useMemo(
    () => [...registered].sort((a, b) => b.trustScore - a.trustScore || b.resolutionsWithinSla - a.resolutionsWithinSla),
    [registered],
  );

  function toggle(address: string) {
    setSelected((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address)
        : prev.length >= MAX_ARBITERS ? prev
          : [...prev, address],
    );
  }

  return (
    <>
      <DialogHeader className="space-y-1.5 px-7 pb-4 pt-7">
        <DialogTitle className="flex items-center gap-2 text-xl tracking-tight">
          <Scales className="h-5 w-5 text-dim" /> Pick arbiters
        </DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed text-dim">
          Up to {MAX_ARBITERS} eligible arbiters seat first if a milestone disputes. Click a row to read their public
          record before you pick.
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[52vh] overflow-y-auto border-y border-line">
        {isLoading ? (
          <div className="p-5"><ArbiterRegistrySkeleton /></div>
        ) : !ranked.length ? (
          <EmptyState
            className="m-5"
            icon={<Scales className="h-5 w-5" />}
            title="No registered arbiters"
            body="Arbiters must stake collateral on-chain before they can be picked. Check back once the roster fills."
          />
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {ranked.map((a) => (
              <ArbiterRow
                key={a.address}
                arbiter={a}
                minStakeWei={minStakeWei}
                picked={selected.includes(a.address)}
                onToggle={() => toggle(a.address)}
              />
            ))}
          </ul>
        )}
      </div>

      <DialogFooter className="flex-col items-stretch gap-3 px-7 py-5 sm:flex-col sm:items-stretch">
        <div className="flex items-center justify-between">
          <span className="num text-[11px] uppercase tracking-wider text-faint">selected {selected.length}/{MAX_ARBITERS}</span>
          {selected.length > 0 && (
            <button type="button" onClick={() => setSelected([])} className="text-[12px] text-faint hover:text-foreground">
              clear
            </button>
          )}
        </div>
        <div className="flex gap-2.5">
          <Button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full bg-white/10 py-3 text-[13px] font-medium hover:bg-white/20"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || selected.length === 0}
            onClick={() => onConfirm(selected)}
            className="flex-1 rounded-full bg-rose-accent py-3 text-[13px] font-medium hover:bg-rose-bright"
          >
            {busy ? "Proposing…" : `Propose ${selected.length || ""}`}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function ArbiterRow({
  arbiter: a,
  minStakeWei,
  picked,
  onToggle,
}: {
  arbiter: ArbiterView;
  minStakeWei: string;
  picked: boolean;
  onToggle: () => void;
}) {
  const tierName = (TIER_NAMES[a.tier ?? 0] ?? "unstaked").toLowerCase();
  const belowMinStake = (() => { try { return BigInt(a.stakeWei || "0") < BigInt(minStakeWei || "0"); } catch { return false; } })();
  const disabled = !a.eligible || belowMinStake;

  return (
    <li className={picked ? "bg-rose-soft/40" : undefined}>
      <div className="flex items-center gap-4 px-6 py-4">
        <button
          type="button"
          aria-label={picked ? "Deselect arbiter" : "Select arbiter"}
          disabled={disabled}
          onClick={onToggle}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            picked
              ? "border-rose-accent bg-rose-accent text-white"
              : disabled
                ? "border-line text-transparent opacity-40"
                : "border-line-strong text-transparent hover:border-rose-accent/60"
          }`}
        >
          <Check weight="bold" className="h-4 w-4" />
        </button>

        <Link
          href={`/profile/${a.address}`}
          className="group flex min-w-0 flex-1 items-center gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <AddressAvatar address={a.address} size={38} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-medium transition-colors group-hover:text-rose-bright">
                {a.profile?.displayName ?? shortAddress(a.address)}
              </span>
              <SealCheck weight="fill" className="h-3.5 w-3.5 shrink-0 text-rose-bright" />
            </span>
            <span className="num mt-0.5 block text-[11.5px] text-faint">
              trust {a.trustScore} · {a.resolutions} resolved · {tierName}
              {disabled ? " · not eligible" : ""}
            </span>
          </span>
        </Link>

        <span className="flex shrink-0 flex-col items-end">
          <span className={`num text-[13.5px] font-medium ${belowMinStake ? "text-state-disputed" : "text-dim"}`}>
            {formatEth(a.stakeWei)}
          </span>
          <span className="num text-[10.5px] uppercase tracking-[0.16em] text-faint">ETH staked</span>
        </span>
      </div>
    </li>
  );
}
