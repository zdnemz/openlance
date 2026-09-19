"use client";

/** /disputes — the queue: open disputes for your projects, arbiter actions. */
import { useState } from "react";
import Link from "next/link";
import { useDisputes, useProjects, useArbiters, useInvalidate, post } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useChainAction } from "@/lib/chain-actions";
import { ListHead, Skeleton, EmptyState, StatusBadge, press, AddressText, HashText } from "@/components/design";
import { timeAgo, timeUntil, shortAddress } from "@/lib/format";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { ShieldStar } from "@phosphor-icons/react/dist/csr/ShieldStar";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function DisputesPage() {
  const session = useSession();
  const { data: disputes, isLoading } = useDisputes();
  const { data: projects } = useProjects();
  const invalidate = useInvalidate();

  if (!session.token) {
    return (
      <EmptyState className="mt-16" title="Disputes are participant-scoped" body="Sign in with a persona involved in the seeded dispute — Mara (client), Rhys (freelancer), or Ingrid (arbiter) — to see the queue from that seat." />
    );
  }

  const open = (disputes ?? []).filter((d) => d.status !== "resolved");
  const resolved = (disputes ?? []).filter((d) => d.status === "resolved");

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[56ch]">
          <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">The arbiter path.</h1>
          <p className="mt-3 text-sm leading-relaxed text-dim">
            Disagreements lock the milestone on-chain and hand coordination to a nominated arbiter. Mutual nomination
            assigns instantly; the 48h fallback lets the platform admin assign one.
          </p>
        </div>
        {(open.length > 0 || resolved.length > 0) && (
          <div className="num pb-1.5 text-right text-[12px] leading-relaxed text-faint">
            {open.length} open · {resolved.length} resolved
            <br />
            SLA clock runs on-chain
          </div>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="h-40 rounded-3xl" />
      ) : !open.length ? (
        <EmptyState icon={<Gavel className="h-5 w-5" />} title="No open disputes" body="When a milestone gets disputed it appears here with its arbiter proposals, SLA clock, and resolution controls." />
      ) : (
        <section className="space-y-4">
          {open.map((d) => (
            <DisputeRow key={d.id} dispute={d} />
          ))}
        </section>
      )}

      {resolved.length > 0 && (
        <section>
          <ListHead>Resolved</ListHead>
          <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
            {resolved.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-1.5 bg-white/[0.012] px-6 py-4">
                <StatusBadge status="resolved_split" pulse={false} />
                <Link href={`/projects/${d.projectId}`} className="num text-[12.5px] text-dim hover:text-foreground">
                  project {d.projectId.slice(0, 8)}
                </Link>
                <span className="num ml-auto text-[12px] text-faint">closed {timeAgo(d.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DisputeRow({ dispute }: { dispute: import("@/lib/types").DisputeView }) {
  const session = useSession();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === dispute.projectId);
  const { data: arbiters } = useArbiters();
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const isAdmin = session.user?.walletAddress === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const assigned = dispute.agreedArbiter ?? dispute.adminAssignedArbiter;
  const isArbiter = session.user?.walletAddress?.toLowerCase() === (assigned ?? "").toLowerCase();
  const windowElapsed = Date.now() > new Date(dispute.agreementDeadline).getTime();

  return (
    <div className="glass rounded-3xl p-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status="disputed" />
        <Link href={`/projects/${dispute.projectId}`} className="text-[14px] font-medium hover:text-rose-bright">
          {project ? "Open project room" : `project ${dispute.projectId.slice(0, 8)}`}
        </Link>
        <span className="num ml-auto text-[12px] text-faint">
          {dispute.status === "open" && !windowElapsed ? `nomination window · ${timeUntil(dispute.agreementDeadline)} left` : dispute.status}
        </span>
      </div>
      <p className="mt-3.5 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{dispute.reason}</p>

      <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-line pt-4">
        <span className="num text-[12px] text-faint">
          client → <span className="text-dim">{dispute.clientProposedArbiter ? shortAddress(dispute.clientProposedArbiter, 4) : "no proposal"}</span>
        </span>
        <span className="num text-[12px] text-faint">
          freelancer → <span className="text-dim">{dispute.freelancerProposedArbiter ? shortAddress(dispute.freelancerProposedArbiter, 4) : "no proposal"}</span>
        </span>
        {assigned && (
          <span className="num flex items-center gap-1.5 text-[12px] text-state-split">
            <Scales className="h-3.5 w-3.5" /> arbiter {shortAddress(assigned, 4)} · SLA {timeUntil(dispute.agreementDeadline)}
          </span>
        )}
      </div>

      {/* arbiter resolution quick panel */}
      {isArbiter && project && (
        <ArbiterResolve dispute={dispute} projectId={dispute.projectId} />
      )}

      {/* admin fallback */}
      {isAdmin && !assigned && windowElapsed && dispute.status === "open" && (
        <div className="mt-5 rounded-2xl border border-rose-accent/25 bg-rose-soft p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-rose-bright">
            <ShieldStar className="h-4 w-4" /> Admin fallback — window elapsed
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(arbiters ?? []).filter((a) => a.registered).map((a) => (
              <button
                key={a.address}
                type="button"
                onClick={async () => {
                  try {
                    await post(`/admin/disputes/${dispute.id}/assign-arbiter`, { arbiterAddress: a.address });
                    invalidate.disputes();
                    toast.success("Arbiter assigned", { description: "The SLA clock starts now." });
                  } catch (err) {
                    toast.error("Assignment failed", { description: err instanceof Error ? err.message : "Unknown error" });
                  }
                }}
                className={`num rounded-full border border-line px-3.5 py-1.5 text-[12px] text-dim hover:border-rose-accent/40 hover:text-foreground ${press}`}
              >
                {a.profile?.displayName ?? shortAddress(a.address)} · trust {a.trustScore}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ArbiterResolve({ dispute, projectId }: { dispute: import("@/lib/types").DisputeView; projectId: string }) {
  const chain = useChainAction();
  const invalidate = useInvalidate();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const milestone = project?.milestones.find((m) => m.id === dispute.milestoneId);

  return (
    <div className="mt-5 rounded-2xl border border-rose-accent/30 bg-rose-soft p-4">
      <div className="text-[13px] font-medium text-rose-bright">You are the arbiter here</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
        Read the evidence in the project room, then execute the outcome on-chain. On-time = +1 trust.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(["release", "refund", "split"] as const).map((outcome) => (
          <Button
            key={outcome}
            disabled={chain.phase !== "idle" && chain.phase !== "done" || milestone?.onchainId == null}
            onClick={async () => {
              const result = await chain.run({
                label: `Resolve — ${outcome}`,
                contract: "escrow",
                functionName: "resolveDispute",
                args: [BigInt(milestone!.onchainId!), outcome === "release" ? 0 : outcome === "refund" ? 1 : 2],
                projectId,
                expect: (p) => ["resolved_release", "resolved_refund", "resolved_split"].includes(p.milestones.find((m) => m.id === dispute.milestoneId)!.chainStatus),
                successMessage: `Resolved — ${outcome}`,
              });
              if (result.ok) {
                invalidate.disputes();
                invalidate.overview();
              }
            }}
            className="rounded-full bg-rose-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-rose-bright"
          >
            {outcome === "split" ? "Split 50/50" : outcome}
          </Button>
        ))}
      </div>
    </div>
  );
}
