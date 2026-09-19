"use client";

/**
 * App shell — asymmetric left rail (desktop) / top+bottom bars (mobile).
 * The calm interior: generous spacing, hairlines over boxes, mono numbers.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/wallet/wallet-button";
import { NotificationBell } from "@/components/notification-bell";
import { useSession, useSessionHydrated } from "@/lib/session";
import { useDisputes, useProjects, useNotifications } from "@/lib/queries";
import { AddressAvatar, StatusDot } from "@/components/design";
import { shortAddress } from "@/lib/format";
import { personaForAddress } from "@/lib/wallet";
import { Compass } from "@phosphor-icons/react/dist/csr/Compass";
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { Layout } from "@phosphor-icons/react/dist/csr/Layout";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { ShieldStar } from "@phosphor-icons/react/dist/csr/ShieldStar";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Bell } from "@phosphor-icons/react/dist/csr/Bell";

export function Logo({ size = "md", withMark = true }: { size?: "sm" | "md"; withMark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      {withMark && (
        <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-rose-accent/15 ring-1 ring-rose-accent/30">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M2 8.5L6 12.5L14 3.5" stroke="#f43f5e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
      <span className={cn("font-semibold tracking-tight", size === "md" ? "text-[17px]" : "text-[15px]")}>
        Escrow<span className="text-rose-bright">Lance</span>
      </span>
    </span>
  );
}

function railItems(admin: boolean, disputesCount: number, unread: number) {
  return [
    { href: "/jobs", label: "Explore", icon: Compass },
    { href: "/jobs/new", label: "Post a job", icon: SquaresFour },
    { href: "/dashboard", label: "Dashboard", icon: Layout },
    { href: "/disputes", label: "Disputes", icon: Gavel, badge: disputesCount || undefined },
    { href: "/arbiters", label: "Arbiters", icon: Scales },
    { href: "/settings/notifications", label: "Notifications", icon: Bell, badge: unread || undefined },
    ...(admin ? [{ href: "/admin", label: "Admin", icon: ShieldStar }] : []),
  ];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const session = useSession();
  const sessionHydrated = useSessionHydrated();
  const isAdmin = sessionHydrated && session.user?.walletAddress === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const { data: disputes } = useDisputes();
  const openDisputes = (disputes ?? []).filter((d) => d.status !== "resolved").length;
  const { data: notifications } = useNotifications();
  const unread = notifications?.unread ?? 0;
  const items = railItems(isAdmin, openDisputes, unread);
  // Gate the persisted-session-derived chip: the server always sees an empty
  // session, so rendering it before localStorage rehydrates would mismatch.
  const address = sessionHydrated ? session.user?.walletAddress : undefined;
  const persona = personaForAddress(address);
  const isBackable = pathname !== "/dashboard" && pathname !== "/jobs";

  return (
    <div className="min-h-[100dvh] w-full">
      {/* ── desktop rail ─────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-ink/70 backdrop-blur-xl lg:flex">
        <div className="flex h-16 items-center px-6">
          <Link href="/" className="transition-opacity hover:opacity-80">
            <Logo />
          </Link>
        </div>
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
              <Link
                href={`/profile/${address}`}
                className="mt-1 flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] text-dim hover:bg-white/[0.04] hover:text-foreground"
              >
                <AddressAvatar address={address} size={26} />
                <span className="min-w-0">
                  <span className="block truncate leading-tight">{session.user?.displayName ?? shortAddress(address)}</span>
                  <span className="block text-[11px] leading-tight text-faint">{persona?.role ?? "member"}</span>
                </span>
              </Link>
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
              <span className="num">anvil devnet · 31337</span>
            </span>
            {sessionHydrated && session.token && <NotificationBell />}
            <WalletButton />
          </div>
        </div>
        <main className="mx-auto w-full max-w-[1200px] px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-16">{children}</main>
      </div>

      {/* ── mobile bottom nav ────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-[68px] items-stretch border-t border-line bg-ink/90 backdrop-blur-xl lg:hidden">
        {[
          { href: "/jobs", label: "Explore", icon: Compass },
          { href: "/dashboard", label: "Work", icon: Layout },
          { href: "/disputes", label: "Disputes", icon: Gavel, badge: openDisputes || undefined },
          { href: "/arbiters", label: "Arbiters", icon: Scales },
        ].map((item) => {
          const active = pathname.startsWith(item.href);
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
