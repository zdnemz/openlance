"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useSession, useSessionHydrated } from "@/lib/session";
import { requiredRolesForPath, roleUpsell } from "@/lib/roles";
import { ShieldStar } from "@phosphor-icons/react";

/**
 * RoleGate — redirect + upsell (never a dead 404).
 * Reads stay open; when the active role may not WRITE here, show the
 * explainer + switch/stake CTA instead of the gated children.
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
        onCta={() => router.push("/dashboard")}
      />
    );
  }
  if (!write) return <>{children}</>;
  const required = requiredRolesForPath(pathname ?? "");
  if (!required || required.includes(session.user.role)) return <>{children}</>;
  const upsell = roleUpsell(pathname ?? "", session.user.role);
  return <GateCard title={upsell.title} body={`${upsell.body} You are ${session.user.role} + KYC ${session.user.kycStatus}.`} cta={upsell.cta} href="/onboarding" />;
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
