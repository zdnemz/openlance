"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useSession, useSessionHydrated } from "@/lib/session";
import { requiredRolesForPath, roleUpsell } from "@/lib/roles";
import { isAllowed } from "@/lib/role-routes";
import { ShieldStar } from "@phosphor-icons/react";

/**
 * RoleGate — redirect + upsell (never a dead 404).
 * Strict separation: the proxy is the enforcer; this covers a stale gate
 * cookie between role switches without a full reload.
 */
export function RoleGate({ children, write = true }: { children: ReactNode; write?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const hydrated = useSessionHydrated();
  if (!hydrated) return <>{children}</>;
  if (!session.token || !session.user) {
    return (
      <GateCard
        title="Connect to continue"
        body="This seat needs a signed-in wallet — connect, sign, then pick your role."
        cta="Connect wallet"
        onCta={() => router.push("/onboarding")}
      />
    );
  }
  if (!write) return <>{children}</>;
  const path = pathname ?? "";
  // Strict read gate (mirrors the proxy): wrong seat sees the upsell.
  if (!isAllowed(path, session.user.role)) {
    return <LockedSeatCard upsell={roleUpsell(path, session.user.role)} role={session.user.role} kyc={session.user.kycStatus} />;
  }
  const required = requiredRolesForPath(path);
  if (!required || required.includes(session.user.role)) return <>{children}</>;
  return <LockedSeatCard upsell={roleUpsell(path, session.user.role)} role={session.user.role} kyc={session.user.kycStatus} />;
}

/**
 * A seat this visitor cannot hold.
 *
 * Deliberately NOT a link to /onboarding: `proxy.ts` one-way-redirects that
 * route for any onboarded user and the API locks the role once onboarding
 * starts, so the CTA used to say "Switch to client" and land on /dashboard with
 * no seat change and no explanation. Disconnecting from the wallet menu is the
 * only thing that actually changes a seat, so say that.
 */
function LockedSeatCard({ upsell, role, kyc }: { upsell: { title: string; body: string; cta: string }; role: string; kyc: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-line bg-white/[0.012] px-6 py-5">
      <div className="flex items-center gap-3">
        <ShieldStar className="h-5 w-5 shrink-0 text-rose-bright" />
        <div>
          <div className="text-[13.5px] font-medium">{upsell.title}</div>
          <div className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-dim">
            {upsell.body} You are {role} + KYC {kyc}. A seat is permanent once onboarding starts — disconnect from the
            header wallet menu to use a different one.
          </div>
        </div>
      </div>
      <span className="shrink-0 rounded-full border border-line px-4 py-2 text-[12.5px] text-faint">
        {upsell.cta} — needs another wallet
      </span>
    </div>
  );
}

function GateCard({ title, body, cta, href, onCta }: { title: string; body: string; cta: string; href?: string; onCta?: () => void }) {
  const inner = (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-rose-accent px-4 py-2 text-[12.5px] font-medium text-white">
      {cta}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-line bg-white/[0.012] px-6 py-5">
      <div className="flex items-center gap-3">
        <ShieldStar className="h-5 w-5 shrink-0 text-rose-bright" />
        <div>
          <div className="text-[13.5px] font-medium">{title}</div>
          <div className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-dim">{body}</div>
        </div>
      </div>
      {href ? <Link href={href}>{inner}</Link> : <button type="button" onClick={onCta}>{inner}</button>}
    </div>
  );
}
