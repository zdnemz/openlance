"use client";

/**
 * Notification bell — the in-app inbox surface for the outbox events (PRD F9).
 * A bell in the top bar shows the unread count; opening it reveals the recent
 * feed, marks it read, and deep-links into the relevant project/dispute.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "@phosphor-icons/react/dist/csr/Bell";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { Handshake } from "@phosphor-icons/react/dist/csr/Handshake";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { cn } from "@/lib/utils";
import { useNotifications, useInvalidate } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { AddressText, EmptyState } from "@/components/design";
import { notifDetail, notifHref, notifMeta, type NotifIcon } from "@/components/notification-meta";
import type { InboxItem } from "@/lib/types";

const ICONS = {
  coins: Coins, zap: Lightning, file: FileText, shield: ShieldWarning,
  scales: Scales, star: Star, handshake: Handshake, bolt: Lightning, bell: Bell,
} satisfies Record<NotifIcon, unknown>;

const TONE_COLOR: Record<string, string> = {
  money: "var(--color-state-funded)",
  dispute: "var(--color-state-disputed)",
  review: "var(--color-rose-bright)",
  proposal: "var(--color-state-submitted)",
  system: "var(--color-dim)",
};

function NotifRow({ item, onNavigate }: { item: InboxItem; onNavigate: () => void }) {
  const meta = notifMeta(item.type);
  const Icon = ICONS[meta.icon] as React.ComponentType<{ weight?: "regular" | "fill"; className?: string; style?: React.CSSProperties }>;
  const detail = notifDetail(item);
  const href = notifHref(item);
  const unread = !item.readAt;

  const inner = (
    <>
      <span
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border"
        style={{
          color: TONE_COLOR[meta.tone],
          borderColor: `color-mix(in oklab, ${TONE_COLOR[meta.tone]} 30%, transparent)`,
          background: `color-mix(in oklab, ${TONE_COLOR[meta.tone]} 10%, transparent)`,
        }}
      >
        <Icon weight="fill" className="h-[15px] w-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[13px]", unread ? "font-medium text-foreground" : "text-dim")}>{meta.label}</span>
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-bright" aria-label="unread" />}
        </span>
        {detail && <span className="mt-0.5 block truncate text-[12px] text-faint">{detail}</span>}
        <span className="mt-1 flex items-center gap-2 text-[11px] text-faint">
          <span className="num">{timeAgo(item.createdAt)}</span>
          {item.actorAddress && <AddressText value={item.actorAddress} className="text-[11px]" />}
        </span>
      </span>
    </>
  );

  const className = "flex gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.04]";
  return href ? (
    <Link href={href} onClick={onNavigate} className={className}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onNavigate} className={cn(className, "w-full text-left")}>
      {inner}
    </button>
  );
}

export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const token = useSession((s) => s.token);
  const { data, isLoading } = useNotifications();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unread = data?.unread ?? 0;
  const items = useMemo(() => (data?.items ?? []).slice(0, 8), [data]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Mark read what the panel actually shows — it lists 8, and marking the
  // whole inbox read hid everything past the eighth.
  const openPanel = async () => {
    setOpen((v) => !v);
    const shown = items.filter((n) => !n.readAt).map((n) => n.id);
    if (!token || shown.length === 0) return;
    try {
      await post("/notifications/read", { ids: shown });
      invalidate.notifications();
    } catch {
      /* a failed read receipt must not block the panel */
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={openPanel}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className={cn(
          "relative grid place-items-center rounded-full border border-line bg-white/[0.03] text-dim transition-colors hover:text-foreground",
          compact ? "h-8 w-8" : "h-9 w-9",
        )}
      >
        <Bell weight={unread > 0 ? "fill" : "regular"} className="h-[17px] w-[17px]" />
        {unread > 0 && (
          <span className="num absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-accent px-1 text-[11px] font-medium text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          // Below `sm` the panel is a viewport-anchored sheet, not a popover
          // hung off the bell: on a phone the bell sits beside the wallet button,
          // so `right-0` + a 360px width pushed the panel off the LEFT edge
          // (max-w only caps width — it never re-anchors), and a 420px list did
          // not fit the viewport. `sm:` keeps the popover, which fits beside the
          // bell once there is room for it.
          className="fixed inset-x-2 top-16 z-50 flex max-h-[calc(100dvh-4.5rem)] flex-col overflow-hidden rounded-2xl border border-line bg-ink/95 shadow-2xl backdrop-blur-xl sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-[360px] sm:max-w-[calc(100vw-2rem)] sm:max-h-none"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-[13px] font-semibold">Notifications</span>
            <Link
              href="/settings/notifications"
              onClick={() => setOpen(false)}
              className="flex items-center gap-1.5 text-[11px] text-faint transition-colors hover:text-dim"
            >
              <GearSix className="h-3.5 w-3.5" />
              Settings
            </Link>
          </div>

          {/* flex-auto, not flex-1: the panel is capped by max-height but has no
              definite height, so a zero flex-basis item has nothing to resolve
              against. min-h-0 is the other half — a flex child defaults to
              min-height:auto and would refuse to shrink, overflowing the capped
              panel (clipped, unreachable) instead of scrolling inside it. */}
          <div className="min-h-0 flex-auto overflow-y-auto p-1.5 sm:max-h-[420px]">
            {!token ? (
              <EmptyState
                icon={<Bell />}
                title="Sign in to see notifications"
                body="Connect a wallet to receive milestone, dispute and review events."
              />
            ) : isLoading ? (
              // Without this the panel flashed "All clear" through every first
              // fetch — telling a user with unread mail that they have none.
              <p className="px-4 py-10 text-center text-sm text-faint">Loading your inbox…</p>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<CheckCircle />}
                title="All clear"
                body="Milestone, dispute and review events will appear here."
              />
            ) : (
              <div className="flex flex-col">
                {items.map((item) => (
                  <NotifRow key={item.id} item={item} onNavigate={() => setOpen(false)} />
                ))}
              </div>
            )}
          </div>

          {token && (
            <Link
              href="/settings/notifications"
              onClick={() => setOpen(false)}
              className="block border-t border-line px-4 py-2.5 text-center text-[12px] text-dim transition-colors hover:bg-white/[0.04] hover:text-foreground"
            >
              View all & manage webhooks
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
