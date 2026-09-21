"use client";

/**
 * /disputes — the arbiter queue for the multi-arbiter model.
 *
 * Opening a dispute selects up to 3 random, eligible arbiters on-chain, who
 * then vote commit-reveal. This page shows each dispute's round: the selected
 * arbiters, the phase/clocks, the tally, and — if you're a selected arbiter —
 * the commit/reveal controls. Parties get tally/finalize/appeal.
 */
import { useState } from "react";
import Link from "next/link";
import { useDisputes, useProjects, useInvalidate, post } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import {
  useChainAction, tallyDisputeAction, finalizeDisputeAction, appealDisputeAction,
} from "@/lib/chain-actions";
import { useRoundState, useDisputeWindows, useNow, computeCommitHash, makeSalt, saveCommit, loadCommit, clearCommit } from "@/lib/dispute-round";
import { DISPUTE_OUTCOME, QUORUM } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { ListHead, Skeleton, EmptyState, StatusBadge, press, AddressText } from "@/components/design";
import { PageHeader } from "@/components/page-header";
import { timeAgo, timeUntil, shortAddress, formatEth, toWei } from "@/lib/format";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { HandCoins } from "@phosphor-icons/react/dist/csr/HandCoins";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { DisputeView } from "@/lib/types";

export default function DisputesPage() {
  const session = useSession();
  const { data: disputes, isLoading } = useDisputes();

  if (!session.token) {
    return (
      <EmptyState className="mt-16" title="Disputes are participant- and arbiter-scoped" body="Sign in with a wallet involved in a dispute — a party or a selected arbiter — to see the queue from that seat." />
    );
  }

  const open = (disputes ?? []).filter((d) => !d.finalized && d.status !== "resolved");
  const resolved = (disputes ?? []).filter((d) => d.finalized || d.status === "resolved");

  return (
    <div className="space-y-10">
      <PageHeader
        title="The arbiter path."
        desc="A dispute locks the milestone and pays the fee. The contract draws up to 3 random, eligible arbiters — never a party — who vote commit-reveal. A 2-of-3 majority decides; the dissent and no-shows are scored."
        meta={(open.length > 0 || resolved.length > 0) ? <>{open.length} open · {resolved.length} settled<br />clocks run on-chain</> : undefined}
      />

      {isLoading ? (
        <Skeleton className="h-40 rounded-3xl" />
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
          <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
            {resolved.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-1.5 bg-white/[0.012] px-6 py-4">
                <StatusBadge status={d.outcome ? `resolved_${d.outcome}` : "resolved_split"} pulse={false} />
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

function DisputeCard({ dispute }: { dispute: DisputeView }) {
  const session = useSession();
  const { address } = useWallet();
  const { data: projects } = useProjects();
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const { disputeFeeWei } = useRuntime();
  const project = projects?.find((p) => p.id === dispute.projectId);
  const milestone = project?.milestones.find((m) => m.id === dispute.milestoneId);
  const round = useRoundState(dispute, milestone?.onchainId ?? null);
  const windows = useDisputeWindows();
  const now = useNow();

  const [outcome, setOutcome] = useState<keyof typeof DISPUTE_OUTCOME>("split");
  const active = chain.phase !== "idle" && chain.phase !== "done";

  const isParticipant = project?.client.id === session.user?.id || project?.freelancer.id === session.user?.id;
  const iAmSelected = round?.arbiters.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const myCommitted = dispute.committedArbiters?.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const myRevealed = dispute.revealedArbiters?.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const allRevealed = !!round && round.arbiterCount > 0 && round.revealCount >= round.arbiterCount;
  const canTally = !!round && !round.resolved && (now > round.revealDeadline || allRevealed);
  // Below quorum the tally is still valid — the contract refunds the opener
  // and returns the milestone to Submitted (no-quorum fallback).
  const tallyFallsBack = !!round && !round.resolved && round.revealCount < QUORUM;
  const canFinalize = !!round && round.resolved && !dispute.finalized && now > round.revealDeadline + windows.appeal;
  // ponytail: derived from the live round + chain windows — the only honest finalize clock.
  const appealEndsAt = round?.resolved && !dispute.finalized ? round.revealDeadline + windows.appeal : null;
  const finalizeInSecs = appealEndsAt !== null ? appealEndsAt - now : 0;
  const phaseLabel = dispute.finalized ? "finalized" : round?.phase ?? dispute.phase;

  return (
    <div className="glass rounded-3xl p-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status="disputed" />
        <Link href={`/projects/${dispute.projectId}`} className="text-[14px] font-medium hover:text-rose-bright">
          {project ? "Open project room" : `project ${dispute.projectId.slice(0, 8)}`}
        </Link>
        <span className="num ml-auto text-[12px] text-faint">
          round {(dispute.round ?? 0) + 1} · {phaseLabel}
          {dispute.appealCount > 0 && ` · ${dispute.appealCount} appeal(s)`}
        </span>
      </div>
      <p className="mt-3.5 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{dispute.reason}</p>

      {/* round summary */}
      <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-line pt-4">
        {round && (
          <>
            <span className="num text-[12px] text-faint">arbiters <span className="text-dim">{round.arbiterCount}</span></span>
            <span className="num text-[12px] text-faint">committed <span className="text-dim">{round.commitCount}</span></span>
            <span className="num text-[12px] text-faint">revealed <span className="text-dim">{round.revealCount}/{round.arbiterCount}</span></span>
            {!round.resolved && round.phase === "commit" && <Clock label="commit closes" at={round.commitDeadline} />}
            {!round.resolved && round.phase === "reveal" && now <= round.revealDeadline && <Clock label="reveal closes" at={round.revealDeadline} />}
          </>
        )}
      </div>

      {/* selected arbiters */}
      {round && round.arbiters.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {round.arbiters.map((a) => {
            const revealed = (dispute.revealedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
            const committed = (dispute.committedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
            return (
              <span key={a} className={`num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${revealed ? "border-state-released/40 text-state-released" : committed ? "border-white/15 text-dim" : "border-line text-faint"}`}>
                <AddressText value={a} size={4} />
                <span className="text-[10px] opacity-70">{revealed ? "revealed" : committed ? "committed" : "pending"}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* arbiter voting */}
      {iAmSelected && !dispute.finalized && round && milestone?.onchainId != null && (
        <div className="mt-5 rounded-2xl border border-rose-accent/30 bg-rose-soft p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-rose-bright">
            <HandCoins className="h-4 w-4" /> You are a selected arbiter
          </div>
          {round.phase === "commit" && (
            <>
              <p className="mt-1.5 text-[12px] leading-relaxed text-faint">Commit a hidden ruling. Nobody can copy it before the reveal phase.</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(["release", "refund", "split"] as const).map((o) => (
                  <button key={o} type="button" onClick={() => setOutcome(o)} className={`rounded-full border px-3 py-2 text-[12px] font-medium ${press} ${outcome === o ? "border-rose-accent bg-white/5 text-foreground" : "border-line text-dim hover:text-foreground"}`}>
                    {o === "split" ? "Split 50/50" : o}
                  </button>
                ))}
              </div>
              <Button
                disabled={active || myCommitted}
                onClick={async () => {
                  const salt = makeSalt();
                  const hash = computeCommitHash(DISPUTE_OUTCOME[outcome], salt, address!, toWei(milestone.onchainId!), dispute.round ?? 0);
                  const r = await chain.run({ label: "Commit vote", contract: "escrow", functionName: "commitVote", args: [toWei(milestone.onchainId!), dispute.round ?? 0, hash] });
                  if (r.ok) {
                    saveCommit(dispute.id, dispute.round ?? 0, outcome, salt);
                    invalidate.disputes();
                  }
                }}
                className="mt-3 w-full rounded-full bg-rose-accent py-2.5 text-[12.5px] font-medium text-white hover:bg-rose-bright"
              >
                {myCommitted ? "Committed — wait for reveal" : `Commit “${outcome === "split" ? "Split 50/50" : outcome}”`}
              </Button>
            </>
          )}
          {round.phase === "reveal" && !myRevealed && now <= round.revealDeadline && milestone?.onchainId != null && (
            <RevealControls dispute={dispute} onchainId={milestone.onchainId} outcome={outcome} setOutcome={setOutcome} onDone={() => invalidate.disputes()} />
          )}
          {myRevealed && <p className="mt-2 text-[12px] text-state-released">Revealed. Waiting for the tally.</p>}
        </div>
      )}

      {/* tally + finalize */}
      {!dispute.finalized && milestone?.onchainId != null && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={active || !canTally} onClick={async () => { const r = await tallyDisputeAction(chain.run)(milestone!.onchainId!, dispute.round ?? 0); if (r.ok) invalidate.disputes(); }} className="rounded-full bg-white/10 py-2.5 text-[12px] font-medium hover:bg-white/20">
              Tally round
            </Button>
            <Button disabled={active || !canFinalize} onClick={async () => { const r = await finalizeDisputeAction(chain.run)(milestone!.onchainId!, dispute.projectId, (p) => ["resolved_release", "resolved_refund", "resolved_split"].includes(p.milestones.find((m) => m.id === dispute.milestoneId)!.chainStatus)); if (r.ok) { invalidate.disputes(); invalidate.overview(); } }} className="rounded-full bg-state-released/15 py-2.5 text-[12px] font-medium text-state-released hover:bg-state-released/25">
              {finalizeInSecs > 0 ? `Finalize ${timeUntil(new Date(appealEndsAt! * 1000).toISOString())}` : "Finalize payout"}
            </Button>
          </div>
          {finalizeInSecs > 0 && (
            <p className="mt-2 text-[12px] text-faint">Payout unlocks once the appeal window closes — anyone can finalize then.</p>
          )}
          {canTally && tallyFallsBack && (
            <p className="mt-2 text-[12px] text-amber-300">Fewer than {QUORUM} reveals — tallying refunds the opener and returns the milestone to Submitted (no-quorum fallback).</p>
          )}
          {isParticipant && round?.resolved && !dispute.finalized && (
            <Button disabled={active} onClick={async () => { const r = await appealDisputeAction(chain.run)(milestone!.onchainId!, toWei(disputeFeeWei), dispute.projectId); if (r.ok) invalidate.disputes(); }} className="mt-2 w-full rounded-full border border-state-disputed/40 py-2 text-[12px] font-medium text-state-disputed hover:bg-state-disputed/10">
              Appeal ({formatEth(disputeFeeWei)} ETH)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function RevealControls({ dispute, onchainId, outcome, setOutcome, onDone }: {
  dispute: DisputeView; onchainId: number; outcome: keyof typeof DISPUTE_OUTCOME;
  setOutcome: (o: keyof typeof DISPUTE_OUTCOME) => void; onDone: () => void;
}) {
  const chain = useChainAction();
  const active = chain.phase !== "idle" && chain.phase !== "done";

  return (
    <>
      <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
        Reveal must match your commit exactly (same outcome + salt) — otherwise the transaction reverts.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {(["release", "refund", "split"] as const).map((o) => (
          <button key={o} type="button" onClick={() => setOutcome(o)} className={`rounded-full border px-3 py-2 text-[12px] font-medium ${press} ${outcome === o ? "border-rose-accent bg-white/5 text-foreground" : "border-line text-dim hover:text-foreground"}`}>
            {o === "split" ? "Split 50/50" : o}
          </button>
        ))}
      </div>
      <Button
        disabled={active}
        onClick={async () => {
          const saved = loadCommit(dispute.id, dispute.round ?? 0);
          if (!saved?.salt) {
            toast.error("No saved commit on this device", { description: "You can only reveal where you committed — the salt never leaves that browser." });
            return;
          }
          if (saved.outcome !== outcome) {
            toast.error("Outcome differs from your commit", { description: `You committed “${saved.outcome}” — switch back before revealing.` });
            setOutcome(saved.outcome as keyof typeof DISPUTE_OUTCOME);
            return;
          }
          const r = await chain.run({ label: "Reveal vote", contract: "escrow", functionName: "revealVote", args: [toWei(onchainId), dispute.round ?? 0, DISPUTE_OUTCOME[outcome], saved.salt] });
          if (r.ok) {
            clearCommit(dispute.id, dispute.round ?? 0);
            onDone();
          }
        }}
        className="mt-3 w-full rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium hover:bg-white/20"
      >
        Reveal “{outcome === "split" ? "Split 50/50" : outcome}”
      </Button>
    </>
  );
}

function Clock({ label, at }: { label: string; at: number }) {
  return (
    <span className="num flex items-center gap-1.5 text-[12px] text-state-split">
      <Scales className="h-3.5 w-3.5" /> {label} {timeUntil(new Date(at * 1000).toISOString())}
    </span>
  );
}
