"use client";

/**
 * /settings/notifications — the notification control room (PRD F9).
 *
 * Three bands, in order of user intent:
 *   1. Inbox — what happened, newest first, with read receipts.
 *   2. Preferences — mute any event type (affects inbox + webhook fan-out).
 *   3. Webhooks — endpoints, signing, delivery log, test + redelivery.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bell } from "@phosphor-icons/react/dist/csr/Bell";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { BellSlash } from "@phosphor-icons/react/dist/csr/BellSlash";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { ToggleLeft } from "@phosphor-icons/react/dist/csr/ToggleLeft";
import { ToggleRight } from "@phosphor-icons/react/dist/csr/ToggleRight";
import { AddressAvatar, EmptyState, press, Skeleton } from "@/components/design";
import { WebhookManager } from "@/components/webhook-manager";
import { useWebhooks, useNotifications, useNotificationPreferences, useInvalidate } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { patch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { notifDetail, notifHref, notifMeta } from "@/components/notification-meta";
import { NOTIFICATION_TYPES, type InboxItem } from "@/lib/types";

function SectionHead({ icon: Icon, title, desc }: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-rose-accent/25 bg-rose-soft text-rose-bright">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-faint">{desc}</p>
      </div>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const meta = notifMeta(item.type);
  const detail = notifDetail(item);
  const href = notifHref(item);
  const unread = !item.readAt;
  const body = (
    <div className={cn("flex items-start gap-3 rounded-2xl border border-line px-4 py-3 transition-colors", href && "hover:bg-white/[0.03]")}>
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", unread ? "bg-rose-bright" : "bg-white/10")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-[13.5px]", unread ? "font-medium" : "text-dim")}>{meta.label}</span>
          <span className="num text-[11px] text-faint">{timeAgo(item.createdAt)}</span>
        </div>
        {detail && <p className="mt-0.5 text-[12.5px] text-dim">{detail}</p>}
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
          {item.actorAddress && (
            <>
              <AddressAvatar address={item.actorAddress} size={16} />
              <span className="num">{item.actorAddress.slice(0, 6)}…{item.actorAddress.slice(-4)}</span>
            </>
          )}
          <span className="font-mono">{item.type}</span>
        </div>
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function InboxBand() {
  const { data, isLoading } = useNotifications();
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(() => (data?.items ?? []).slice(0, showAll ? 50 : 12), [data, showAll]);

  return (
    <section>
      <SectionHead
        icon={Bell}
        title="Inbox"
        desc="Every domain event you're party to — milestones, disputes, reviews — recorded off-chain and mirrored from chain events by the indexer."
      />
      {isLoading ? (
        <div className="space-y-2.5"><Skeleton className="h-16 rounded-2xl" /><Skeleton className="h-16 rounded-2xl" /></div>
      ) : items.length === 0 ? (
        <EmptyState icon={<CheckCircle className="h-5 w-5" />} title="Nothing yet" body="Fund a milestone, submit work or open a dispute and the events land here." />
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => <InboxRow key={item.id} item={item} />)}
          {(data?.items.length ?? 0) > 12 && !showAll && (
            <button type="button" onClick={() => setShowAll(true)} className="w-full rounded-2xl border border-dashed border-line py-2.5 text-[12px] text-faint transition-colors hover:text-dim">
              Show more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function PreferencesBand() {
  const { data, isLoading } = useNotificationPreferences();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<string | null>(null);

  const mutedSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of data?.preferences ?? []) if (p.muted) s.add(p.eventType);
    return s;
  }, [data]);

  const toggle = async (eventType: string, muted: boolean) => {
    setBusy(eventType);
    try {
      await patch("/notifications/preferences", { eventType, muted });
      invalidate.notificationPreferences();
      invalidate.notifications();
    } catch {
      toast.error("Could not update preference");
    } finally {
      setBusy(null);
    }
  };

  const globalMuted = mutedSet.has("*");

  return (
    <section>
      <SectionHead
        icon={BellSlash}
        title="Preferences"
        desc="Mute a type to stop both the in-app inbox projection and webhook fan-out for it. Globally-sourced (chain) events are always recorded on the ledger — muting only silences delivery."
      />
      {isLoading ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line">
          <ToggleRow
            label="Mute everything"
            hint="Turn off all inbox + webhook delivery"
            muted={globalMuted}
            busy={busy === "*"}
            onToggle={() => toggle("*", !globalMuted)}
            strong
          />
          <div className="grid sm:grid-cols-2">
            {(data?.types ?? NOTIFICATION_TYPES).map((t) => (
              <ToggleRow
                key={t}
                label={notifMeta(t).label}
                hint={t}
                muted={mutedSet.has(t)}
                busy={busy === t}
                onToggle={() => toggle(t, !mutedSet.has(t))}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ToggleRow({ label, hint, muted, busy, onToggle, strong = false }: {
  label: string; hint: string; muted: boolean; busy: boolean; onToggle: () => void; strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={cn(
        "flex w-full items-center gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] last:border-b-0 disabled:opacity-60",
        strong && "bg-white/[0.02]",
      )}
    >
      {muted
        ? <ToggleLeft className="h-5 w-5 shrink-0 text-faint" />
        : <ToggleRight className="h-5 w-5 shrink-0 text-rose-bright" />}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[13px]", strong ? "font-medium" : "text-dim")}>{label}</span>
        <span className="block truncate font-mono text-[10.5px] text-faint">{hint}</span>
      </span>
      <span className={cn("shrink-0 text-[11px]", muted ? "text-faint" : "text-state-released")}>{muted ? "muted" : "on"}</span>
    </button>
  );
}

function WebhooksBand() {
  const { data, isLoading } = useWebhooks();
  const invalidate = useInvalidate();
  return (
    <section>
      <SectionHead
        icon={PaperPlaneTilt}
        title="Webhooks"
        desc="Push every event to your own endpoint as a signed JSON envelope. HMAC-SHA256 over the exact body; retries back off 10s → 40s → 160s → 640s → ~43m across 5 attempts."
      />
      <WebhookManager subscriptions={data ?? []} loading={isLoading} reload={invalidate.webhooks} />
    </section>
  );
}

export default function NotificationsSettingsPage() {
  const session = useSession();
  return (
    <div className="space-y-9">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-[60ch]">
          <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">Notifications &amp; webhooks.</h1>
          <p className="mt-3 text-sm leading-relaxed text-dim">
            The contract is the source of truth; this is the delivery layer around it. In-app inbox, per-type
            mute, and self-serve webhook endpoints — all fed by one transactional outbox so nothing is lost
            between a state change and a notification.
          </p>
        </div>
        <span className="num pb-1.5 text-right text-[12px] leading-relaxed text-faint">
          endpoint signing: HMAC-SHA256
          <br />
          retry ladder: 5 attempts
        </span>
      </div>

      {!session.token ? (
        <EmptyState
          icon={<Bell className="h-5 w-5" />}
          title="Connect a wallet"
          body="Sign in with your wallet to see your notifications and manage webhook endpoints."
        />
      ) : (
        <div className="space-y-10">
          <InboxBand />
          <PreferencesBand />
          <WebhooksBand />
        </div>
      )}
    </div>
  );
}
