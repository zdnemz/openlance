"use client";

/**
 * OpenLance design primitives — pixel art on dark ink: square corners, 2px
 * frames, one rose accent, mono numerals, sprite identity.
 */
import { ComponentProps, useState } from "react";
import { cn } from "@/lib/utils";
import { MILESTONE_LABELS, STATE_COLORS, formatEth, formatEthSummary, shortAddress, shortHash } from "@/lib/format";
import { Check, Copy, Spinner } from "@/components/icons";
import { Sprite, SpriteAvatar } from "@/components/pixel-art";
import type { SpriteName } from "@/components/pixel-sprites";
/* ── Status ─────────────────────────────────────────────────────────────── */

export function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="absolute inset-0 breathe" style={{ background: color }} aria-hidden />}
      <span className="relative inline-flex h-2.5 w-2.5" style={{ background: color }} />
    </span>
  );
}

export function StatusBadge({ status, pulse = true, className }: { status: string; pulse?: boolean; className?: string }) {
  const color = STATE_COLORS[status] ?? "var(--color-state-pending)";
  const live = ["funded", "submitted", "disputed", "open", "in_progress"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 border-2 px-2 py-0.5 text-[12px] font-semibold uppercase leading-5 tracking-wide",
        className,
      )}
      style={{ color, borderColor: color, background: `color-mix(in oklab, ${color} 12%, transparent)` }}
    >
      <StatusDot color={color} pulse={pulse && live} />
      {MILESTONE_LABELS[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Chip({ children, className, ...rest }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border-2 border-line bg-white/[0.03] px-2 py-0.5 text-[13px] leading-5 text-dim",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/* ── Numbers & identity ─────────────────────────────────────────────────── */

/**
 * `decimals` caps a LIFETIME TOTAL's precision (default 4) — pass it for sums
 * like "earned on-chain", which accumulate per-milestone fee dust and otherwise
 * print all 18 decimals. Omit it and the amount stays exact, which is what a
 * figure the user signs, sends or adds up has to be.
 */
export function EthAmount({ wei, className, suffix = true, decimals }: { wei: string | bigint | null | undefined; className?: string; suffix?: boolean; decimals?: number }) {
  return (
    <span className={cn("num", className)}>
      {decimals === undefined ? formatEth(wei) : formatEthSummary(wei, decimals)}
      {suffix && <span className="ml-1 text-[max(0.72em,12px)] text-faint">ETH</span>}
    </span>
  );
}

/**
 * Deterministic address avatar — an 8x8 pixel sprite grown from the address
 * bits (see SpriteAvatar). Kept under this name so call sites read as before.
 */
export function AddressAvatar({ address, size = 36, className }: { address: string | null | undefined; size?: number; className?: string }) {
  if (!address) return <span className={cn("inline-block border-2 border-line bg-white/5", className)} style={{ width: size, height: size }} />;
  return <SpriteAvatar address={address} size={size} className={className} />;
}

export function Copyable({ text, children, className }: { text: string; children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        // `navigator.clipboard` is undefined on an insecure origin, and
        // permission can be denied — both used to throw/reject with no handler,
        // and the "copied" tick was shown either way.
        const write = navigator.clipboard?.writeText(text);
        if (!write) return;
        void write
          .then(() => setCopied(true))
          .catch(() => {})
          .finally(() => setTimeout(() => setCopied(false), 1200));
      }}
      className={cn("group inline-flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground", className)}
      title="Copy"
    >
      {children}
      {copied ? <Check weight="bold" className="h-4 w-4 text-state-released" /> : <Copy className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60" />}
    </button>
  );
}

export function HashText({ value, size = 4, className }: { value: string | null | undefined; size?: number; className?: string }) {
  if (!value) return <span className={cn("num text-faint", className)}>—</span>;
  return (
    <Copyable text={value} className={cn("num", className)}>
      <span className="underline decoration-white/30 decoration-2 decoration-dotted underline-offset-4">{shortHash(value, size)}</span>
    </Copyable>
  );
}

export function AddressText({ value, size = 4, className }: { value: string | null | undefined; size?: number; className?: string }) {
  return <span className={cn("num text-dim", className)}>{shortAddress(value, size)}</span>;
}

/* ── Layout atoms ───────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer", className)} />;
}

/**
 * Full-surface loading placeholder for the arbiter registry list. Reads come
 * straight from the chain (no DB cache), so the fetch is slower and can flicker;
 * this holds a stable, ranked shape until the roster lands.
 */
export function ArbiterRegistrySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y-2 divide-line overflow-hidden border-2 border-line" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex flex-col gap-4 bg-ink-raised px-6 py-6 md:flex-row md:items-center">
          <Skeleton className="h-7 w-10" />
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <Skeleton className="h-11 w-11 shrink-0" />
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-2.5 w-56" />
            </div>
          </div>
          <div className="hidden items-center gap-6 md:flex">
            <Skeleton className="h-6 w-10" />
            <Skeleton className="h-6 w-10" />
            <Skeleton className="h-6 w-10" />
          </div>
          <Skeleton className="h-6 w-24 md:w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * Inline spinner + label for smaller arbiter surfaces (profile badge, dashboard
 * counters) where a block skeleton would be too heavy.
 */
export function InlineLoading({ label = "Reading the registry…", className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-faint", className)} aria-busy="true" aria-live="polite">
      <Spinner className="h-4 w-4 animate-spin" />
      <span className="text-[13px]">{label}</span>
    </span>
  );
}

/** Functional list-section heading: small pixel caps, one per list. */
export function ListHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("font-display text-[12px] uppercase leading-snug text-foreground", className)}>{children}</h2>;
}

export function EmptyState({
  icon,
  sprite,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  /** A pixel sprite instead of an icon — the friendlier choice for a true "nothing here yet". */
  sprite?: SpriteName;
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 border-2 border-dashed border-line-strong px-8 py-14 text-center", className)}>
      {sprite ? <Sprite name={sprite} size={64} /> : icon && <div className="text-faint [&_svg]:h-8 [&_svg]:w-8">{icon}</div>}
      <div className="font-display text-[12px] leading-snug">{title}</div>
      {body && <p className="max-w-[46ch] text-[15px] leading-relaxed text-faint">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Tactile press — the face drops two pixels toward its slab (see .pixel-press). */
export const press = "pixel-press";
