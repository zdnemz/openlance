"use client";

/**
 * App shell — asymmetric left rail (desktop) / top+bottom bars (mobile).
 * Strict seats: the rail and bottom nav render only the active role's pages
 * (the proxy enforces the same matrix server-side). /dashboard is the single
 * adaptive home every seat shares.
 * The calm interior: generous spacing, hairlines over boxes, mono numbers.
 */
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/wallet/wallet-button";
import { NotificationBell } from "@/components/notification-bell";
import { useSession, useSessionHydrated } from "@/lib/session";
import { useDisputes, useProjects, useNotifications } from "@/lib/queries";
import { AddressAvatar, StatusDot } from "@/components/design";
import { shortAddress } from "@/lib/format";
import { useRuntime } from "@/lib/runtime";
import type { UserRole } from "@/lib/types";
import { Compass } from "@phosphor-icons/react/dist/csr/Compass";
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { Layout } from "@phosphor-icons/react/dist/csr/Layout";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { ShieldStar } from "@phosphor-icons/react/dist/csr/ShieldStar";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Bell } from "@phosphor-icons/react/dist/csr/Bell";

export function Logo({ size = "md", withMark = true }: { size?: "sm" | "md"; withMark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      {/* Real brand mark — src/app/icon.svg, served at /icon.svg (single source of truth, also the favicon). */}
      {withMark && <Image src="/icon.svg" alt="OpenLance" width={32} height={32} priority className="h-8 w-8 rounded-lg" />}
      <span className={cn("font-semibold tracking-tight", size === "md" ? "text-[17px]" : "text-[15px]")}>
        Open<span className="text-rose-bright">Lance</span>
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
      if (session.user?.role) {
        document.cookie = `el_role=${session.user.role}; path=/; max-age=2592000; samesite=lax`;
      } else if (!session.token) {
        document.cookie = `el_role=; path=/; max-age=0; samesite=lax`;
      }
    } catch { /* noop */ }
  }, [sessionHydrated, session.user?.role, session.token]);
  const items = railItems(role, isAdmin, openDisputes, unread, kycNone);
  const mobile = bottomItems(role, openDisputes);
  // Gate the persisted-session-derived chip: the server always sees an empty
  // session, so rendering it before localStorage rehydrates would mismatch.
  const address = sessionHydrated ? session.user?.walletAddress : undefined;
  const roleLine = session.user ? `${session.user.role} · kyc ${session.user.kycStatus}` : "member";
  const isBackable = pathname !== "/dashboard" && pathname !== "/jobs" && pathname !== "/stake";

  return (
    <div className="min-h-[100dvh] w-full">
      {/* ── desktop rail ─────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-ink/70 backdrop-blur-xl lg:flex">
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/" className="transition-opacity hover:opacity-80">
            <Logo />
          </Link>
        </div>
        {role && (
          <div className="px-6 pb-1">
            <span className="num inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[10.5px] uppercase tracking-[0.14em] text-dim">
              <StatusDot color="#f43f5e" />
              {role} seat
            </span>
          </div>
        )}
        <nav className="mt-2 flex flex-1 flex-col gap-0.5 px-3">
          {items.map((item) => {
            const active = pathname === item.href || (item.href !== "/jobs/new" && pathname.startsWith(`${item.href}/`));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13.5px] transition-colors",
                  active ? "bg-rose-soft text-foreground" : "text-dim hover:bg-white/[0.04] hover:text-foreground",
                )}
              >
                {active && <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-rose-bright" />}
                <Icon weight={active ? "fill" : "regular"} className={cn("h-[17px] w-[17px]", active && "text-rose-bright")} />
                {item.label}
                {item.badge ? (
                  <span className="num ml-auto rounded-full bg-rose-accent/20 px-1.5 py-0.5 text-[11px] text-rose-bright">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}

          <div className="mt-auto pb-4">
            <a
              href="/console"
              className="flex items-center gap-2.5 rounded-xl px-3.5 py-2 text-xs text-faint transition-colors hover:text-dim"
            >
              <TerminalWindow className="h-4 w-4" />
              Backend console
            </a>
            {address && (
              <div className="mt-1 rounded-xl px-1 py-1">
                <Link
                  href="/profile/me"
                  className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] text-dim hover:bg-white/[0.04] hover:text-foreground"
                >
                  <AddressAvatar address={address} size={26} />
                  <span className="min-w-0">
                    <span className="block truncate leading-tight">{session.user?.displayName ?? shortAddress(address)}</span>
                    <span className="block text-[11px] leading-tight text-faint">{roleLine}</span>
                  </span>
                </Link>
                <Link
                  href="/onboarding"
                  className="num mt-0.5 block rounded-lg px-3.5 py-1.5 text-[11px] text-faint transition-colors hover:text-dim"
                >
                  Switch seat →
                </Link>
              </div>
            )}
          </div>
        </nav>
      </aside>

      {/* ── mobile top bar ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-ink/80 px-4 backdrop-blur-xl lg:hidden">
        {isBackable ? (
          <button type="button" onClick={() => history.back()} className="flex items-center gap-1.5 text-sm text-dim" aria-label="Back">
            <ArrowLeft className="h-4 w-4" /> <Logo size="sm" withMark={false} />
          </button>
        ) : (
          <Link href="/">
            <Logo size="sm" />
          </Link>
        )}
        <div className="flex items-center gap-2">
          {role && (
            <span className="num rounded-full border border-line bg-white/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-wider text-dim">
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
            <span className="flex items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[11px] text-dim">
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
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-[68px] items-stretch border-t border-line bg-ink/90 backdrop-blur-xl lg:hidden">
        {mobile.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-1 flex-col items-center justify-center gap-1 text-[11px]",
                active ? "text-rose-bright" : "text-faint",
              )}
            >
              <Icon weight={active ? "fill" : "regular"} className="h-5 w-5" />
              {item.label}
              {item.badge ? (
                <span className="num absolute right-[22%] top-2.5 rounded-full bg-rose-accent px-1 text-[10px] text-white">
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
