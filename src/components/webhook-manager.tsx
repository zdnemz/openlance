"use client";

/**
 * Webhook manager — create/list/delete subscriptions, test-ping an endpoint,
 * rotate the HMAC secret, and inspect the delivery log with manual redelivery.
 * Backed by /api/webhooks*; the signing contract is documented inline so users
 * know exactly how to verify our calls.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ArrowsCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowsCounterClockwise";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Copyable, EmptyState, press, Skeleton } from "@/components/design";
import { get, post, del } from "@/lib/api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { NOTIFICATION_TYPES } from "@/lib/types";
import type { WebhookDelivery, WebhookSubscription } from "@/lib/types";

const DELIVERY_ICON = { success: CheckCircle, failed: WarningCircle, pending: Clock } as const;
const DELIVERY_COLOR = {
  success: "var(--color-state-released)",
  failed: "var(--color-state-disputed)",
  pending: "var(--color-state-pending)",
} as const;

function DeliveryRow({ delivery, onRedeliver }: {
  delivery: WebhookDelivery;
  onRedeliver: (id: string) => Promise<void>;
}) {
  const Icon = DELIVERY_ICON[delivery.status];
  const color = DELIVERY_COLOR[delivery.status];
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
      <Icon weight="fill" className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className="num w-40 shrink-0 truncate text-dim">{delivery.envelope?.type ?? "—"}</span>
      <span className="num hidden flex-1 truncate text-faint sm:block">
        {delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : delivery.lastError ?? "queued"}
        {delivery.attempts > 0 && ` · ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}`}
      </span>
      <span className="num shrink-0 text-faint">{timeAgo(delivery.createdAt)}</span>
      {delivery.status !== "pending" && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRedeliver(delivery.id);
            } finally {
              setBusy(false);
            }
          }}
          className={cn("shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-40", press)}
          title="Redeliver"
        >
          retry
        </button>
      )}
    </div>
  );
}

function SubscriptionCard({ sub, onChanged }: { sub: WebhookSubscription; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(sub.secret);

  const load = async () => {
    const next = !open;
    setOpen(next);
    if (next && deliveries === null) {
      try {
        const res = await get<{ items: WebhookDelivery[]; total: number }>(`/webhooks/${sub.id}/deliveries?limit=50`);
        setDeliveries(res.items);
      } catch {
        toast.error("Could not load deliveries");
      }
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await post(`/webhooks/${sub.id}/test`, {});
      toast.success("Test delivery queued", { description: sub.url });
      if (open) setDeliveries(null);
    } catch (e) {
      toast.error("Test failed", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const res = await post<{ secret: string }>(`/webhooks/${sub.id}/rotate`, {});
      setSecret(res.secret);
      toast.success("Secret rotated", { description: "Update your endpoint's verifier." });
      onChanged();
    } catch {
      toast.error("Rotation failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await del(`/webhooks/${sub.id}`);
      toast.success("Subscription deleted");
      onChanged();
    } catch {
      toast.error("Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const redeliver = async (deliveryId: string) => {
    try {
      await post(`/webhooks/${sub.id}/deliveries/${deliveryId}/redeliver`, {});
      const res = await get<{ items: WebhookDelivery[]; total: number }>(`/webhooks/${sub.id}/deliveries?limit=50`);
      setDeliveries(res.items);
      toast.success("Redelivery queued");
    } catch (e) {
      toast.error("Redelivery failed", { description: e instanceof Error ? e.message : undefined });
    }
  };

  const stats = sub.stats ?? { pending: 0, success: 0, failed: 0, total: 0 };
  const scope = sub.eventTypes.length === 0 ? "all events" : `${sub.eventTypes.length} event types`;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white/[0.012]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <button type="button" onClick={load} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={open}>
          <CaretDown className={cn("h-3.5 w-3.5 shrink-0 text-faint transition-transform", open && "rotate-180")} />
          <span className="min-w-0">
            <span className="block truncate font-mono text-[13px] text-foreground">{sub.url}</span>
            <span className="mt-0.5 block text-[11px] text-faint">{scope}</span>
          </span>
        </button>

        <span className="num hidden text-[11px] text-faint md:block">
          <span className="text-state-released">{stats.success}</span> ·{" "}
          <span className="text-state-disputed">{stats.failed}</span> ·{" "}
          <span>{stats.pending}</span>
        </span>

        <div className="flex items-center gap-1.5">
          <button type="button" onClick={test} disabled={busy} title="Send test ping"
            className={cn("grid h-7 w-7 place-items-center rounded-lg border border-line text-dim transition-colors hover:text-foreground disabled:opacity-40", press)}>
            <PaperPlaneTilt className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={rotate} disabled={busy} title="Rotate secret"
            className={cn("grid h-7 w-7 place-items-center rounded-lg border border-line text-dim transition-colors hover:text-foreground disabled:opacity-40", press)}>
            <ArrowsCounterClockwise className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={remove} disabled={busy} title="Delete subscription"
            className={cn("grid h-7 w-7 place-items-center rounded-lg border border-line text-dim transition-colors hover:text-[var(--color-state-disputed)] disabled:opacity-40", press)}>
            <Trash className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center gap-2 bg-white/[0.02] px-4 py-2.5 text-[11px] text-faint">
            <span>Signing secret</span>
            <Copyable text={secret} className="font-mono text-dim">
              <span>{secret.slice(0, 10)}…{secret.slice(-6)}</span>
            </Copyable>
            <span className="ml-auto">Verify: HMAC-SHA256(body) → <span className="num">X-OpenLance-Signature: sha256=…</span></span>
          </div>
          <div className="max-h-72 divide-y divide-white/[0.04] overflow-y-auto">
            {deliveries === null ? (
              <div className="p-3"><Skeleton className="h-9 rounded-lg" /></div>
            ) : deliveries.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12px] text-faint">No deliveries yet — hit the test button.</p>
            ) : (
              deliveries.map((d) => (
                <DeliveryRow key={d.id} delivery={d} onRedeliver={redeliver} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function authHeaders(): HeadersInit {
  try {
    const raw = localStorage.getItem("el:session");
    const token = raw ? (JSON.parse(raw)?.state?.token as string | undefined) : undefined;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function WebhookManager({ subscriptions, loading, reload }: {
  subscriptions: WebhookSubscription[];
  loading: boolean;
  reload: () => void;
}) {
  const [url, setUrl] = useState("");
  const [showScope, setShowScope] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!url.trim()) return;
    setCreating(true);
    try {
      await post("/webhooks", { url: url.trim(), eventTypes: selected });
      toast.success("Webhook created", { description: "We signed a fresh secret for it." });
      setUrl("");
      setSelected([]);
      setShowScope(false);
      reload();
    } catch (e) {
      toast.error("Could not create webhook", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setCreating(false);
    }
  };

  const toggle = (t: string) =>
    setSelected((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line bg-white/[0.012] p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="https://example.com/hooks/openlance"
            className="h-10 flex-1 rounded-xl border border-line bg-white/[0.03] px-3 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-faint focus:border-rose-accent/50"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating || !url.trim()}
            className={cn("flex h-10 items-center justify-center gap-2 rounded-xl bg-rose-accent px-4 text-[13px] font-medium text-white transition-opacity disabled:opacity-40", press)}
          >
            <Plus weight="bold" className="h-4 w-4" />
            Add endpoint
          </button>
        </div>

        <button type="button" onClick={() => setShowScope((v) => !v)} className="mt-2.5 flex items-center gap-1.5 text-[11px] text-faint hover:text-dim">
          <CaretDown className={cn("h-3 w-3 transition-transform", showScope && "rotate-180")} />
          {selected.length === 0 ? "Subscribed to all events" : `${selected.length} event types selected`}
        </button>

        {showScope && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {NOTIFICATION_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggle(t)}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                  selected.includes(t)
                    ? "border-rose-accent/40 bg-rose-soft text-rose-bright"
                    : "border-line text-faint hover:text-dim",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-2.5">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-16 rounded-2xl" />
        </div>
      ) : subscriptions.length === 0 ? (
        <EmptyState
          icon={<PaperPlaneTilt className="h-5 w-5" />}
          title="No endpoints yet"
          body="Add a URL above and OpenLance will POST a signed JSON envelope on every matching event — with retries and a full delivery log."
        />
      ) : (
        <div className="space-y-2.5">
          {subscriptions.map((s) => (
            <SubscriptionCard key={s.id} sub={s} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
