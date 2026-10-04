"use client";

/**
 * App shell — asymmetric left rail (desktop) / top+bottom bars (mobile).
 * Strict seats: the rail and bottom nav render only the active role's pages
 * (the proxy enforces the same matrix server-side). /dashboard is the single
 * adaptive home every seat shares.
 * The calm interior: flat slabs with 2px frames, mono numbers, no motion
 * beyond a blinking status square and the active-item cursor.
 */
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/wallet/wallet-button";
import { NotificationBell } from "@/components/notification-bell";
import { useSession, useSessionHydrated } from "@/lib/session";
import { useDisputes, useProjects, useNotifications } from "@/lib/queries";
import { AddressAvatar, StatusDot } from "@/components/design";
import { PixelMark } from "@/components/pixel-art";
import { shortAddress } from "@/lib/format";
import { useRuntime } from "@/lib/runtime";
import type { UserRole } from "@/lib/types";
import { ArrowLeft, Bell, Coins, Compass, Gavel, Layout, Scales, SealCheck, ShieldStar, SquaresFour, TerminalWindow } from "@/components/icons";
export function Logo({ size = "md", withMark = true }: { size?: "sm" | "md"; withMark?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      {/* The mark is drawn in code (components/pixel-sprites.ts) — the same art as app/icon.svg. */}
      {withMark && <PixelMark size={size === "md" ? 32 : 24} />}
      <span className={cn("font-display leading-none", size === "md" ? "text-[13px]" : "text-[11px]")}>
        OPEN<span className="text-rose-light">LANCE</span>
      </span>
    </span>
  );
}

type RailItem = { href: string; label: string; icon: React.ComponentType<{ weight?: "fill" | "regular"; className?: string }>; badge?: number };

function railItems(role: UserRole | undefined, admin: boolean, disputesCount: number, unread: number, kycNone: boolean): RailItem[] {
  const notifs: RailItem = { href: "/settings/notifications", label: "Notifications", icon: Bell, badge: unread || undefined };
  const onboarding: RailItem[] = kycNone ? [{ href: "/onboarding", label: "Onboarding", icon: ShieldStar }] : [];
  const adminItem: RailItem[] = admin ? [{ href: "/admin", label: "Admin", icon: ShieldStar }] : [];
  const disputes: RailItem = { href: "/disputes", label: "Disputes", icon: Gavel, badge: disputesCount || undefined };

  if (role === "arbiter") {
    return [
      { href: "/dashboard", label: "Dashboard", icon: Layout },
      { href: "/stake", label: "Stake", icon: Coins },
      { href: "/arbiters", label: "Registry", icon: Scales },
      disputes,
      ...onboarding,
      notifs,
      ...adminItem,
    ];
  }
  if (role === "freelancer") {
    return [
      { href: "/jobs", label: "Explore", icon: Compass },
      { href: "/dashboard", label: "Dashboard", icon: Layout },
      disputes,
      ...onboarding,
      notifs,
      ...adminItem,
    ];
  }
  if (role === "client") {
    return [
      { href: "/jobs", label: "Explore", icon: Compass },
      { href: "/jobs/new", label: "Post a job", icon: SquaresFour },
      { href: "/dashboard", label: "Dashboard", icon: Layout },
      disputes,
      ...onboarding,
      notifs,
      ...adminItem,
    ];
  }
  return [
    { href: "/jobs", label: "Explore", icon: Compass },
    { href: "/dashboard", label: "Dashboard", icon: Layout },
    disputes,
    notifs,
  ];
}

/**
 * The nav item that owns the current route, by longest matching href: `/jobs`
 * must not light up for `/jobs/new`, so the more specific child wins.
 */
function activeHref(pathname: string, items: RailItem[]): string | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

function bottomItems(role: UserRole | undefined, disputesCount: number): RailItem[] {
  if (role === "arbiter") {
    return [
      { href: "/dashboard", label: "Work", icon: Layout },
      { href: "/stake", label: "Stake", icon: Coins },
      { href: "/disputes", label: "Disputes", icon: Gavel, badge: disputesCount || undefined },
      { href: "/arbiters", label: "Registry", icon: Scales },
    ];
  }
  if (role === "freelancer") {
    return [
      { href: "/jobs", label: "Explore", icon: Compass },
      { href: "/dashboard", label: "Work", icon: Layout },
      { href: "/disputes", label: "Disputes", icon: Gavel, badge: disputesCount || undefined },
      { href: "/settings/notifications", label: "Alerts", icon: Bell },
    ];
  }
  return [
    { href: "/jobs", label: "Explore", icon: Compass },
    { href: "/jobs/new", label: "Post", icon: SquaresFour },
    { href: "/dashboard", label: "Work", icon: Layout },
    { href: "/disputes", label: "Disputes", icon: Gavel, badge: disputesCount || undefined },
  ];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const sessionHydrated = useSessionHydrated();
  const chainId = useRuntime((s) => s.chainId);
  const isAdmin = sessionHydrated && !!session.user?.isAdmin;
  const { data: disputes } = useDisputes();
  const openDisputes = (disputes ?? []).filter((d) => d.status !== "resolved").length;
  const { data: notifications } = useNotifications();
  const unread = notifications?.unread ?? 0;
  const kycNone = sessionHydrated && !!session.token && session.user?.kycStatus === "none";
  const role = sessionHydrated ? session.user?.role : undefined;
  // Mirror the seat into a readable cookie so the edge proxy can guard
  // without a DB lookup (covers sessions minted before the role cookie
  // existed; the API remains the security boundary, this is navigation).
  useEffect(() => {
    if (!sessionHydrated) return;
    try {
      // A session with no role must CLEAR the hint, not leave the previous
      // account's seat in place — a stale `el_role` keeps the edge proxy
      // guarding this visitor as a role they no longer hold.
      if (session.user?.role) {
        document.cookie = `el_role=${session.user.role}; path=/; max-age=2592000; samesite=lax`;
      } else {
        document.cookie = `el_role=; path=/; max-age=0; samesite=lax`;
      }
    } catch { /* noop */ }
  }, [sessionHydrated, session.user?.role]);
  const items = railItems(role, isAdmin, openDisputes, unread, kycNone);
  const mobile = bottomItems(role, openDisputes);
  const railActive = activeHref(pathname, items);
  const mobileActive = activeHref(pathname, mobile);
  // Gate the persisted-session-derived chip: the server always sees an empty
  // session, so rendering it before localStorage rehydrates would mismatch.
  const address = sessionHydrated ? session.user?.walletAddress : undefined;
  // The seal is the whole signal. Spelling "kyc verified" beside it said the
  // same thing twice in a 13px rail, and the unverified states are already
  // surfaced where they matter — the Onboarding rail item below and the
  // dashboard banner — so the chip never needs to restate them.
  const roleLine = session.user ? session.user.role : "member";
  const isBackable = pathname !== "/dashboard" && pathname !== "/jobs" && pathname !== "/stake";
  // `history.back()` on a deep link (a shared project room, a notification, a
  // pasted URL) walks the visitor straight out of the app into whatever page
  // was open before this tab. Only offer Back once the router has actually
  // moved within the app; otherwise the header falls back to the home logo.
  // State, not a ref: a ref read during render does not re-render on change.
  const [landedAt] = useState(() => pathname);
  const [movedInApp, setMovedInApp] = useState(false);
  useEffect(() => {
    if (landedAt !== pathname) setMovedInApp(true);
  }, [landedAt, pathname]);
  const canGoBack = isBackable && movedInApp;

  return (
    <div className="min-h-[100dvh] w-full">
      {/* ── desktop rail ─────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r-2 border-line-strong bg-ink-raised lg:flex">
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/" className="transition-opacity hover:opacity-80" aria-label="OpenLance home">
            <Logo />
          </Link>
        </div>
        {role && (
          <div className="px-6 pb-1">
            <span className="inline-flex items-center gap-2 border-2 border-line-strong bg-ink px-2.5 py-1 text-[13px] font-semibold uppercase tracking-wide text-dim">
              <StatusDot color="#fb7185" />
              {role} seat
            </span>
          </div>
        )}
        <nav className="mt-3 flex flex-1 flex-col gap-1.5 px-3" aria-label="Primary">
          {items.map((item) => {
            const active = item.href === railActive;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group relative flex min-h-11 items-center gap-3 border-2 px-3 py-2 font-display text-[11px] uppercase leading-none transition-colors",
                  active ? "border-rose-accent bg-rose-soft text-white" : "border-transparent text-dim hover:border-line-strong hover:bg-ink-hover hover:text-foreground",
                )}
              >
                <Icon weight={active ? "fill" : "regular"} className={cn("h-6 w-6 shrink-0", active && "text-rose-light")} />
                {item.label}
                {item.badge ? (
                  <span className="num ml-auto border-2 border-rose-accent bg-rose-accent px-1.5 py-0.5 text-[13px] leading-none text-white">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}

          <div className="mt-auto pb-4">
            <a
              href="/console"
              className="flex items-center gap-2.5 px-3.5 py-2 text-xs text-faint transition-colors hover:text-dim"
            >
              <TerminalWindow className="h-5 w-5" />
              Backend console
            </a>
            {address && (
              <div className="mt-1 border-t-2 border-line pt-2">
                <Link
                  href="/profile/me"
                  className="flex min-h-11 items-center gap-2.5 px-2 py-2 text-[15px] text-dim hover:bg-ink-hover hover:text-foreground"
                >
                  <AddressAvatar address={address} size={32} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="block truncate leading-tight">{session.user?.displayName ?? shortAddress(address)}</span>
                      {session.user?.kycStatus === "verified" && <SealCheck weight="fill" className="h-4 w-4 shrink-0 text-state-released" />}
                    </span>
                    <span className="block text-[13px] uppercase leading-tight text-faint">{roleLine}</span>
                  </span>
                </Link>
                {/* Not a link: the proxy one-way-redirects /onboarding for any
                    onboarded user and the API locks the role after onboarding
                    starts, so this route can never change a seat. Disconnecting
                    from the wallet menu is the only path that can. */}
                <p className="mt-0.5 block px-2 py-1.5 text-[13px] leading-snug text-faint">
                  Seat is permanent — disconnect to use another wallet
                </p>
              </div>
            )}
          </div>
        </nav>
      </aside>

      {/* ── mobile top bar ───────────────────────────────────────────── */}
      {/* z-50, not z-40: the notification panel is an absolutely-positioned
          descendant of this bar, so its own z-50 resolves INSIDE this stacking
          context and can never lift it above the z-40 bottom nav below — the
          panel's footer and last rows rendered behind the nav. Raising the
          ancestor is the only thing that can. The two never overlap. */}
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b-2 border-line-strong bg-ink px-4 lg:hidden">
        {canGoBack ? (
          <button type="button" onClick={() => router.back()} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-dim" aria-label="Back">
            <ArrowLeft className="h-6 w-6" /> <Logo size="sm" withMark={false} />
          </button>
        ) : (
          <Link href="/">
            <Logo size="sm" />
          </Link>
        )}
        <div className="flex items-center gap-2">
          {role && (
            <span className="border-2 border-line-strong bg-ink-raised px-2 py-0.5 text-[13px] font-semibold uppercase tracking-wide text-dim">
              {role}
            </span>
          )}
          {sessionHydrated && session.token && <NotificationBell compact />}
          <WalletButton compact />
        </div>
      </header>

      {/* ── content ──────────────────────────────────────────────────── */}
      <div className="lg:pl-60">
        <div className="mx-auto hidden h-16 max-w-[1200px] items-center justify-end px-8 lg:flex">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 border-2 border-line bg-ink-raised px-3 py-1.5 text-[13px] text-dim">
              <StatusDot color="#34d399" pulse />
              <span className="num">{chainId === 84532 ? "base sepolia · 84532" : `env chain · ${chainId}`} · testnet, no real funds</span>
            </span>
            {sessionHydrated && session.token && <NotificationBell />}
            <WalletButton />
          </div>
        </div>
        <main className="mx-auto w-full max-w-[1200px] px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-16">{children}</main>
      </div>

      {/* ── mobile bottom nav ────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-[72px] items-stretch border-t-2 border-line-strong bg-ink lg:hidden" aria-label="Primary">
        {mobile.map((item) => {
          const active = item.href === mobileActive;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-1 flex-col items-center justify-center gap-0.5 pt-1 text-[13px] leading-none transition-colors",
                active ? "bg-rose-soft text-white" : "text-faint hover:text-foreground",
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-1 bg-rose-accent" aria-hidden />}
              <Icon weight={active ? "fill" : "regular"} className={cn("h-6 w-6", active && "text-rose-light")} />
              {item.label}
              {item.badge ? (
                <span className="num absolute right-[22%] top-2 border-2 border-ink bg-rose-accent px-1 text-[12px] leading-4 text-white">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
