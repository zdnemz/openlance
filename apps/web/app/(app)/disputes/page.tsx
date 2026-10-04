"use client";

/**
 * /disputes — the arbiter queue for the multi-arbiter model.
 *
 * Opening a dispute selects up to 3 random, eligible arbiters on-chain, who
 * then vote commit-reveal. This page shows each dispute's round: the selected
 * arbiters, the phase/clocks, the tally, and — if you're a selected arbiter —
 * the commit/reveal controls. Parties get tally/finalize/appeal.
 */
import Link from "next/link";
import { useDisputes } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { ListHead, Skeleton, EmptyState, StatusBadge } from "@/components/design";
import { PageHeader } from "@/components/page-header";
import { timeAgo } from "@/lib/format";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { DisputePanel } from "@/components/dispute-panel";
import type { DisputeView } from "@/lib/types";

export default function DisputesPage() {
  const session = useSession();
  const { data: disputes, isLoading } = useDisputes();

  if (!session.token) {
    return (
      <EmptyState className="mt-16" title="Disputes are participant- and arbiter-scoped" body="Sign in with a wallet involved in a dispute — a party or a selected arbiter — to see the queue from that seat." />
    );
  }

  // A dispute leaves the open queue when the money moved (`status: "resolved"`,
  // stamped by the chain's DisputeResolved), NOT when the round was tallied —
  // `finalized` is the tally flag, and a tallied round still owes the escrowed
  // ETH a `finalizeDispute` that this queue is where you press.
  const open = (disputes ?? []).filter((d) => d.status !== "resolved");
  const resolved = (disputes ?? []).filter((d) => d.status === "resolved");

  return (
    <div className="space-y-10">
      <PageHeader
        title="The arbiter path."
        desc="A dispute locks the milestone and pays the fee. The contract draws up to 3 random, eligible arbiters — never a party — who vote commit-reveal. A 2-of-3 majority decides; the dissent and no-shows are scored."
        meta={(open.length > 0 || resolved.length > 0) ? <>{open.length} open · {resolved.length} settled<br />clocks run on-chain</> : undefined}
      />

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : !open.length ? (
        <EmptyState icon={<Gavel className="h-5 w-5" />} title="No open disputes" body="When a milestone is disputed it appears here with its selected arbiters, commit-reveal clocks and tally." />
      ) : (
        <section className="space-y-4">
          {open.map((d) => (
            <DisputeCard key={d.id} dispute={d} />
          ))}
        </section>
      )}

      {resolved.length > 0 && (
        <section>
          <ListHead>Settled</ListHead>
          <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden border border-line">
            {resolved.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-1.5 bg-white/[0.012] px-6 py-4">
                <StatusBadge status={d.outcome ? `resolved_${d.outcome}` : "resolved_split"} pulse={false} />
                <Link href={`/projects/${d.projectId}?fromDisputes=1`} className="num text-[12.5px] text-dim hover:text-foreground">
                  <ProjectName disputeName={d.projectName} />
                </Link>
                <span className="num ml-auto text-[12px] text-faint">closed {timeAgo(d.finalizedAt ?? d.resolvedAt ?? d.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One open dispute. The header names it and links to the room; every decision
 * belongs to `DisputePanel`, which is the same component the project room
 * renders — the two used to be separate copies that had already drifted, and
 * this page's copy resolved the milestone through `useProjects()`, which is
 * empty for an arbiter. So it showed an arbiter a dispute card with no round,
 * no clocks and no controls: the one page built for that seat did nothing.
 */
function DisputeCard({ dispute }: { dispute: DisputeView }) {
  // Tallied, but the payout has not been claimed yet — say so, because that is
  // exactly the state where the Finalize button below is the only way out.
  const phaseLabel = dispute.finalized && dispute.status !== "resolved" ? "awaiting payout" : dispute.phase;

  return (
    <div className="glass p-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={dispute.finalized && dispute.status !== "resolved" ? "submitted" : "disputed"} />
        <Link href={`/projects/${dispute.projectId}?fromDisputes=1`} className="text-[14px] font-medium hover:text-rose-bright">
          <ProjectName disputeName={dispute.projectName} />
        </Link>
        <span className="num ml-auto text-[12px] text-faint">
          round {(dispute.round ?? 0) + 1} · {phaseLabel}
          {dispute.appealCount > 0 && ` · ${dispute.appealCount} appeal(s)`}
        </span>
      </div>
      <p className="mt-3.5 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{dispute.reason}</p>

      <div className="mt-5 border-t border-line pt-4">
        <DisputePanel dispute={dispute} compact />
      </div>
    </div>
  );
}

/**
 * Project display name for a dispute row. The API attaches `projectName` (the
 * job title) precisely so a selected arbiter can name a dispute without
 * project-list access — their list is empty by design. The local project/job
 * lookups behind it can only ever have helped a party, so they went: a name
 * that depends on access the viewer may not have is a name that flickers.
 */
function ProjectName({ disputeName }: { disputeName?: string | null }) {
  return <>{disputeName ?? "Project room"}</>;
}
