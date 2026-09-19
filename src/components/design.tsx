"use client";

/**
 * OpenLance design primitives — dark premium, one rose accent, mono numerals.
 */
import { ComponentProps, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { MILESTONE_LABELS, STATE_COLORS, formatEth, shortAddress, shortHash } from "@/lib/format";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";

/* ── Status ─────────────────────────────────────────────────────────────── */

export function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && (
        <span className="absolute inset-0 rounded-full opacity-45 breathe" style={{ background: color }} aria-hidden />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function StatusBadge({ status, pulse = true, className }: { status: string; pulse?: boolean; className?: string }) {
  const color = STATE_COLORS[status] ?? "var(--color-state-pending)";
  const live = ["funded", "submitted", "disputed", "open", "in_progress"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        className,
      )}
      style={{ color, borderColor: `color-mix(in oklab, ${color} 32%, transparent)`, background: `color-mix(in oklab, ${color} 9%, transparent)` }}
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
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-0.5 text-[11px] text-dim",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/* ── Numbers & identity ─────────────────────────────────────────────────── */

export function EthAmount({ wei, className, suffix = true }: { wei: string | bigint | null | undefined; className?: string; suffix?: boolean }) {
  return (
    <span className={cn("num", className)}>
      {formatEth(wei)}
      {suffix && <span className="ml-1 text-[max(0.72em,11px)] text-faint">ETH</span>}
    </span>
  );
}

/** Deterministic address avatar — hue pair + geometry from the hash bits. */
export function AddressAvatar({ address, size = 36, className }: { address: string | null | undefined; size?: number; className?: string }) {
  const { hue1, hue2, shape, id } = useMemo(() => {
    const a = (address ?? "0x0").toLowerCase();
    const h1 = parseInt(a.slice(2, 6) || "0", 16) % 360;
    const h2 = (h1 + 130 + (parseInt(a.slice(6, 8) || "0", 16) % 80)) % 360;
    const shape = parseInt(a.slice(9, 11) || "0", 16) % 4;
    // Deterministic gradient id derived from the address — MUST be identical on
    // the server and the client. `Math.random()` here caused a hydration
    // mismatch (different `id`/`fill` attributes on each render).
    const id = `av-${a.slice(2, 10) || "default"}-${h1}-${h2}`;
    return { hue1: h1, hue2: h2, shape, id };
  }, [address]);
  if (!address) return <span className={cn("inline-block rounded-full bg-white/5", className)} style={{ width: size, height: size }} />;

  const shapes = [
    <circle key="c" cx="50" cy="50" r="34" fill={`url(#g-${id})`} />,
    <rect key="r" x="16" y="16" width="68" height="68" rx="18" fill={`url(#g-${id})`} />,
    <polygon key="p" points="50,12 88,82 12,82" fill={`url(#g-${id})`} stroke="none" />,
    <rect key="s" x="14" y="14" width="72" height="72" rx="36" fill={`url(#g-${id})`} />,
  ];

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue1} 62% 46%)`} />
          <stop offset="100%" stopColor={`hsl(${hue2} 48% 30%)`} />
        </linearGradient>
      </defs>
      {shapes[shape]}
      <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
    </svg>
  );
}

export function Copyable({ text, children, className }: { text: string; children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn("group inline-flex items-center gap-1.5 transition-colors hover:text-foreground", className)}
      title="Copy"
    >
      {children}
      {copied ? <Check weight="bold" className="h-3 w-3 text-state-released" /> : <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />}
    </button>
  );
}

export function HashText({ value, size = 4, className }: { value: string | null | undefined; size?: number; className?: string }) {
  if (!value) return <span className={cn("num text-faint", className)}>—</span>;
  return (
    <Copyable text={value} className={cn("num", className)}>
      <span className="underline decoration-white/20 underline-offset-4">{shortHash(value, size)}</span>
    </Copyable>
  );
}

export function AddressText({ value, size = 4, className }: { value: string | null | undefined; size?: number; className?: string }) {
  return <span className={cn("num text-dim", className)}>{shortAddress(value, size)}</span>;
}

/* ── Layout atoms ───────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer rounded-lg", className)} />;
}

export function ListHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("text-[13px] font-semibold tracking-normal text-foreground/90", className)}>{children}</h2>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line px-8 py-14 text-center", className)}>
      {icon && <div className="text-faint [&_svg]:h-7 [&_svg]:w-7">{icon}</div>}
      <div className="text-[15px] font-medium">{title}</div>
      {body && <p className="max-w-[46ch] text-sm leading-relaxed text-faint">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Tactile button press — the physical push the design system standardizes. */
export const press = "active:translate-y-px active:scale-[0.985] transition-transform";
