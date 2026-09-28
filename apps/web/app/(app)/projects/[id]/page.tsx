"use client";

/**
 * /projects/:id — THE PROJECT ROOM.
 * Milestone state machine + wallet actions + chat + on-chain activity.
 * Every money movement: wallet signs → tx mines → indexer mirrors (three-phase
 * honest UX: signing / mining / indexing).
 */
import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet";
import { AnimatePresence, motion } from "framer-motion";
import {
  useProject, useJob, useMessages, useSubmissions, useMilestoneReviews, useDisputes, useArbiters,
  useLedger, useInvalidate, post, patch,
} from "@/lib/queries";
import { useSession } from "@/lib/session";
import { del } from "@/lib/api";
import {
  useChainAction, openDisputeAction, commitVoteAction, revealVoteAction, tallyDisputeAction,
  finalizeDisputeAction, appealDisputeAction, readJobBudget,
} from "@/lib/chain-actions";
import {
  useRoundState, useDisputeWindows, useNow, computeCommitHash, makeSalt, saveCommit, loadCommit, clearCommit,
} from "@/lib/dispute-round";
import { DISPUTE_OUTCOME, QUORUM } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import {
  AddressAvatar, AddressText, EthAmount, HashText, ListHead, Skeleton, EmptyState, press,
  StatusBadge, Copyable,
} from "@/components/design";
import { STATE_COLORS, MILESTONE_LABELS, formatEth, toWei, shortAddress, timeAgo, timeUntil, feeOn } from "@/lib/format";
import type { ProjectMilestone, DisputeView } from "@/lib/types";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArbiterPickerDialog } from "@/components/arbiter-picker-dialog";
import { ArbiterBubbles } from "@/components/arbiter-bubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LockKeyOpen } from "@phosphor-icons/react/dist/csr/LockKeyOpen";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { ChatCircleDots } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { Pulse } from "@phosphor-icons/react/dist/csr/Pulse";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { HandCoins } from "@phosphor-icons/react/dist/csr/HandCoins";

export default function ProjectRoomPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = use(params);
  const session = useSession();
  const { data: project, isLoading } = useProject(id);
  const { data: disputes } = useDisputes();
  // Escape hatch for strangers bounced here by the job→project redirect: the
  // raw param never touches href (open-redirect) — strict uuid shape only.
  // fromDisputes covers board entries (no job id travels there; /disputes is static).
  const sp = use(searchParams);
  const fromJobParam = sp?.fromJob;
  const backToJob = typeof fromJobParam === "string" && /^[0-9a-fA-F-]{36}$/.test(fromJobParam) ? fromJobParam : null;
  const backToDisputes = !backToJob && sp?.fromDisputes === "1";

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-24 w-full rounded-3xl" />
        <Skeleton className="h-96 w-full rounded-3xl" />
      </div>
    );
  }
  if (!project) {
    return (
      <EmptyState
        title="Project not found, or it is not yours to see"
        body="Projects are visible to their participants and assigned arbiters only. Sign in with a participating client/freelancer wallet — or the seated/selected arbiter wallet — to open this room."
        action={backToJob ? (
          <Link href={`/jobs/${backToJob}?stay=1`} className="mt-1 inline-block rounded-full bg-white/10 px-5 py-2.5 text-[13px] font-medium hover:bg-white/20">
            Back to job posting
          </Link>
        ) : backToDisputes ? (
          <Link href="/disputes" className="mt-1 inline-block rounded-full bg-white/10 px-5 py-2.5 text-[13px] font-medium hover:bg-white/20">
            Back to disputes
          </Link>
        ) : undefined}
      />
    );
  }

  const isClient = project.client.id === session.user?.id;
  const isFreelancer = project.freelancer.id === session.user?.id;

  return (
    <div className="space-y-8">
      <ProjectHeader id={id} />
      <ArbiterPanel id={id} />
      {!isClient && !isFreelancer && (
        <div className="glass flex items-center gap-3 rounded-2xl px-5 py-4 text-[13px] text-dim">
          <Warning className="h-4 w-4 shrink-0 text-amber-300" />
          You are viewing as a non-participant; sign in as <AddressText value={project.client.walletAddress} className="text-foreground" /> (client) or{" "}
          <AddressText value={project.freelancer.walletAddress} className="text-foreground" /> (freelancer) to act on this project.
        </div>
      )}
      <Tabs defaultValue="milestones" className="gap-6">
        <TabsList className="h-auto gap-7 border-b border-line bg-transparent p-0 pb-px">
          <TabsTrigger value="milestones" className="rounded-none px-0 pb-2.5 text-[13.5px] text-dim data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_0_var(--color-rose-bright)]">
            Milestones
          </TabsTrigger>
          <TabsTrigger value="chat" className="rounded-none px-0 pb-2.5 text-[13.5px] text-dim data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_0_var(--color-rose-bright)]">
            Chat
          </TabsTrigger>
          <TabsTrigger value="activity" className="rounded-none px-0 pb-2.5 text-[13.5px] text-dim data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_0_var(--color-rose-bright)]">
            On-chain activity
          </TabsTrigger>
        </TabsList>
        <TabsContent value="milestones">
          <MilestonesTab projectId={id} />
        </TabsContent>
        <TabsContent value="chat">
          <ChatTab projectId={id} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab projectId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── header ────────────────────────────────────────────────────────────── */

function ProjectHeader({ id }: { id: string }) {
  const { data: project } = useProject(id);
  const { data: job, isLoading: jobLoading } = useJob(project?.jobId ?? "");
  const { data: disputes } = useDisputes();
  const dispute = disputes?.find((d) => d.projectId === id && d.status !== "resolved");

  if (!project) return null;
  // The project name is its job title. While the job loads, hold a skeleton
  // in the h1 so the heading never flashes an id first (no id fallback ever).
  const jobTitle: string | undefined = job?.title;
  const heading = jobTitle ?? project.milestones[0]?.title ?? "Project room";
  const escrowed = project.milestones.filter((m) => ["funded", "submitted", "disputed"].includes(m.chainStatus));
  const released = project.milestones.filter((m) => ["released", "resolved_release", "resolved_split"].includes(m.chainStatus));
  const escrowedWei = escrowed.reduce((a, m) => a + toWei(m.amountWei), 0n);
  const releasedWei = released.reduce((a, m) => a + toWei(m.amountWei), 0n);

  return (
    <div className="glass rounded-3xl p-7 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusBadge status={project.status === "active" ? "funded" : project.status} />
            {dispute && <StatusBadge status="disputed" />}
          </div>
          <h1 className="display mt-3 max-w-[36ch] text-[27px] leading-[1.1] md:text-[32px]">
            {jobLoading && !jobTitle ? <Skeleton className="inline-block h-9 w-72 align-middle" /> : heading}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            <Party label="client" who={project.client} />
            <span className="h-4 w-px bg-white/10" aria-hidden />
            <Party label="freelancer" who={project.freelancer} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-5 text-right sm:flex sm:gap-10">
          <div>
            <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">in escrow</div>
            <EthAmount wei={escrowedWei} className="mt-1.5 block text-xl font-medium text-amber-300" />
          </div>
          <div>
            <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">released</div>
            <EthAmount wei={releasedWei} className="mt-1.5 block text-xl font-medium text-state-released" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Party({ label, who }: { label: string; who: { id: string; walletAddress: string; displayName: string | null } }) {
  return (
    <Link href={`/profile/${who.walletAddress}`} className="flex items-center gap-2.5 text-dim transition-colors hover:text-foreground">
      <AddressAvatar address={who.walletAddress} size={30} />
      <span>
        <span className="block text-[13px] leading-tight text-foreground">{who.displayName ?? shortAddress(who.walletAddress)}</span>
        <span className="num block text-[11px] leading-tight text-faint">{label}</span>
      </span>
    </Link>
  );
}

/* ── mutual arbiter lock ─────────────────────────────────────────────── */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function ArbiterPanel({ id }: { id: string }) {
  const { data: project } = useProject(id);
  const session = useSession();
  const invalidate = useInvalidate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!project) return null;
  const locked = (project.chosenArbiters ?? []) as string[];
  const proposal = project.arbiterProposal as { proposerId: string; addresses: string[] } | null;
  const isParty = project.client.id === session.user?.id || project.freelancer.id === session.user?.id;
  const mine = !!proposal && proposal.proposerId === session.user?.id;

  async function propose(addresses: string[]) {
    if (addresses.length < 1 || addresses.length > 3) {
      toast.error("Propose 1–3 arbiters", { description: "Pick up to three from the roster." });
      return;
    }
    setBusy(true);
    try {
      await post(`/projects/${id}/arbiters/propose`, { addresses });
      invalidate.project(id);
      setPickerOpen(false);
      toast.success("Arbiters proposed", { description: "The counterparty approves to lock them in." });
    } catch (err) {
      toast.error("Could not propose", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      await post(`/projects/${id}/arbiters/approve`, {});
      invalidate.project(id);
      toast.success("Arbiters locked", { description: "They seat first if a milestone ever disputes." });
    } catch (err) {
      toast.error("Could not lock", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await post(`/projects/${id}/arbiters/reject`, {});
      invalidate.project(id);
      toast.success("Proposal rejected", { description: "Back to nothing picked — you can propose again." });
    } catch (err) {
      toast.error("Could not reject", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass rounded-3xl p-6">
      <div className="flex items-center gap-2.5">
        <Scales className="h-4 w-4 text-dim" />
        <ListHead>Mutual arbiters · {locked.length > 0 ? `${locked.length} locked` : proposal ? "awaiting approval" : "none picked"}</ListHead>
      </div>
      {locked.length > 0 ? (
        <div className="mt-3 space-y-3">
          <ArbiterBubbles addresses={locked} tone="locked" />
          <p className="text-[12px] text-faint">They seat first if a milestone disputes; ineligible entries fall back to random draw.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {proposal && (
            <div className="rounded-2xl border border-line bg-white/[0.02] p-4">
              <div className="num text-[11px] uppercase tracking-wider text-faint">{mine ? "your proposal — waiting on counterparty" : "counterparty proposal"}</div>
              {/* Bubbles: click one for the reputation detail + approve/reject. */}
              <div className="mt-2.5">
                <ArbiterBubbles
                  addresses={proposal.addresses}
                  actions={!mine && isParty ? { busy, onApprove: approve, onReject: reject } : undefined}
                />
              </div>
              {!mine && isParty && (
                <p className="mt-2.5 text-[11.5px] text-faint">Open a bubble to review, then approve &amp; lock or reject the whole proposal.</p>
              )}
            </div>
          )}
          {isParty && (
            <Button
              disabled={busy}
              onClick={() => setPickerOpen(true)}
              className="rounded-full bg-white/10 px-5 py-2.5 text-[12.5px] font-medium hover:bg-white/20"
            >
              {proposal ? "Replace proposal" : "Add arbiters"}
            </Button>
          )}
          {!isParty && !proposal && <p className="text-[12px] text-faint">No arbiters picked yet — the parties agree up to 3 after award.</p>}
        </div>
      )}

      <ArbiterPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={propose}
        initial={proposal?.addresses ?? []}
        busy={busy}
      />
    </section>
  );
}

/* ── milestones tab ────────────────────────────────────────────────────── */

function MilestonesTab({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const milestones = project?.milestones ?? [];
  const selected = milestones.find((m) => m.id === selectedId) ?? milestones[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      <div className="min-w-0 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
        {milestones.map((m) => (
          <MilestoneCard key={m.id} milestone={m} selected={selected?.id === m.id} onSelect={() => setSelectedId(m.id)} />
        ))}
      </div>
      {selected && <MilestonePanel projectId={projectId} milestone={selected} />}
    </div>
  );
}

function MilestoneCard({ milestone: m, selected, onSelect }: { milestone: ProjectMilestone; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full px-6 py-5 text-left transition-colors ${press} ${
        selected ? "bg-rose-soft" : "bg-white/[0.012] hover:bg-white/[0.035]"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="num text-[11px] text-faint">{String(m.position).padStart(2, "0")}</span>
            <StatusBadge status={m.chainStatus} />
            {m.softStatus === "changes_requested" && (
              <span className="num rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300">changes requested</span>
            )}
          </div>
          <div className="mt-2.5 text-[16px] font-medium tracking-tight">{m.title}</div>
        </div>
        <div className="shrink-0 text-right">
          <EthAmount wei={m.amountWei} className="text-base font-medium" />
          {m.onchainId !== null && <div className="num mt-1 text-[11px] text-faint">on-chain #{m.onchainId}</div>}
        </div>
      </div>
      <p className="mt-2.5 line-clamp-2 text-[13px] leading-relaxed text-faint">{m.description}</p>
    </button>
  );
}

/** Terminal milestone states — a milestone that will never move again. */
const COMPLETE_STATES = ["released", "resolved_release", "resolved_refund", "resolved_split", "cancelled"];

/* ── milestone action panel (the state machine cockpit) ───────────────── */

function MilestonePanel({ projectId, milestone: m }: { projectId: string; milestone: ProjectMilestone }) {
  const session = useSession();
  const { address } = useWallet();
  const { data: project } = useProject(projectId);
  const { data: submissions } = useSubmissions(projectId, m.id);
  const { data: reviews } = useMilestoneReviews(m.id);
  const { data: disputes } = useDisputes();
  const { data: arbiters } = useArbiters();
  const { feeBps, disputeFeeWei, escrow, chainMode } = useRuntime();
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  // Mirror-lag guard: once the chain says funded while the mirror still says
  // pending, the Fund button stays dead until the indexer catches up.
  const [fundState, setFundState] = useState<"idle" | "checking" | "landed">("idle");
  const fundCheckedRef = useRef<string | null>(null);
  // Every milestone still sitting at pending_funding — funded together in one tx.
  // Derived before the early return so the stale-mirror effect below can use it.
  const outstanding = (project?.milestones ?? []).filter((x) => x.chainStatus === "pending_funding" && x.fund);
  const outstandingWei = outstanding.reduce((acc, x) => acc + BigInt(x.fund?.amountWei ?? "0"), 0n);
  const outstandingJobRef = outstanding[0]?.fund?.jobRef ?? outstanding[0]?.fund?.ref ?? null;
  const outstandingKey = outstandingJobRef ? `${outstandingJobRef}:${outstandingWei}` : "";
  const cardStatus = m.chainStatus;

  // Proactive stale-mirror check: a mined funding tx can leave the mirror at
  // pending_funding (indexer lag/outage) while work has already started. Chain
  // budget is truth — when it can't cover the outstanding sum, funding landed:
  // hide Fund and show the waiting notice without needing a click first.
  useEffect(() => {
    if (!escrow || !outstandingKey || !outstandingJobRef || cardStatus !== "pending_funding") return;
    if (fundCheckedRef.current === outstandingKey) return;
    fundCheckedRef.current = outstandingKey;
    let cancelled = false;
    setFundState("checking");
    readJobBudget(escrow, outstandingJobRef)
      .catch(() => null)
      .then((budget) => {
        if (cancelled) return;
        setFundState(budget && outstandingWei > budget.free ? "landed" : "idle");
      });
    return () => { cancelled = true; };
  }, [escrow, outstandingKey, outstandingJobRef, outstandingWei, cardStatus]);

  if (!project) return null;
  const isClient = project.client.id === session.user?.id;
  const isFreelancer = project.freelancer.id === session.user?.id;
  const dispute = disputes?.find((d) => d.milestoneId === m.id);
  const canReview = ["released", "resolved_release", "resolved_refund", "resolved_split"].includes(m.chainStatus);
  // Reviews are party-only: an assigned arbiter reading the room must never
  // see the counterparty review form (the API also requires participation).
  const showReview = canReview && (isClient || isFreelancer);
  // Reviews close the whole engagement: every milestone must be complete.
  const projectComplete = project.milestones.length > 0 && project.milestones.every((x) => COMPLETE_STATES.includes(x.chainStatus));
  const myReview = reviews?.find((r) => r.reviewerId === session.user?.id);
  const fee = feeOn(m.amountWei, feeBps);
  const active = chain.phase !== "idle" && chain.phase !== "done";
  // Locked mutual arbiters seat first on-chain; otherwise the draw is random.
  const lockedPreferred = ((project.chosenArbiters ?? []) as string[]).filter(Boolean).slice(0, 3);
  const preferredArg = lockedPreferred.length > 0
    ? [...lockedPreferred, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR].slice(0, 3)
    : null;
  // ponytail: warn-only pre-flight — never hard-block (registry can change
  // pre-mine; the mock roster lives outside useArbiters, so only real mode warns).
  const parties = new Set([project.client.walletAddress?.toLowerCase(), project.freelancer.walletAddress?.toLowerCase()]);
  const eligibleSeats = (arbiters ?? []).filter((a) => a.eligible && !parties.has(a.address.toLowerCase())).length;
  const quorumRisk = chainMode === "real" && arbiters !== undefined && eligibleSeats < QUORUM;

  const wait = (status: string | string[]) => (p: import("@/lib/types").ProjectView) =>
    (Array.isArray(status) ? status : [status]).includes(p.milestones.find((x) => x.id === m.id)!.chainStatus);

  /**
   * Fund-all: one signature locks every outstanding milestone from the job
   * budget. This is the recovery path for when the award-time batch tx was
   * skipped or rejected — the normal flow funds at award.
   *
   * Pre-flight against on-chain truth first: the mirror can lag a mined funding
   * tx, and sending a second batch would just revert with InsufficientBudget.
   */
  async function fundAllMilestones() {
    if (!outstanding.length || fundState !== "idle") return;
    const jobRef = outstanding[0]!.fund!.jobRef ?? outstanding[0]!.fund!.ref;
    const freelancer = project!.freelancer.walletAddress;
    if (escrow) {
      setFundState("checking");
      const budget = await readJobBudget(escrow, jobRef).catch(() => null);
      if (budget && outstandingWei > budget.free) {
        setFundState("landed");
        toast.success("Already funded on-chain", {
          description: "The funding transaction landed — the view refreshes as soon as the indexer mirrors it.",
        });
        invalidate.project(projectId);
        invalidate.overview();
        return;
      }
      setFundState("idle");
    }
    return chain.run({
      label: "Fund all milestones",
      contract: "escrow",
      functionName: "fundAllFromCredit",
      args: [
        jobRef,
        outstanding.map((x) => x.fund!.ref),
        outstanding.map(() => freelancer),
        outstanding.map((x) => BigInt(x.fund!.amountWei)),
      ],
      projectId,
      expect: (p) => p.milestones.every((x) => x.chainStatus !== "pending_funding"),
      successMessage: "Milestones funded — work needs no further signatures",
    });
  }

  async function offchainThenChain<T>(path: string, body: unknown, chainCall: (posted: T | null) => Promise<{ ok: boolean }>) {
    try {
      const posted = path ? await post<T>(path, body) : null;
      const result = await chainCall(posted);
      if (result.ok) {
        invalidate.project(projectId);
        invalidate.disputes();
        invalidate.overview();
      }
    } catch (err) {
      toast.error("Action failed", { description: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  return (
    <div className="glass-raised h-fit rounded-3xl p-6 lg:sticky lg:top-24">
      <div className="flex items-center justify-between">
        <ListHead>Milestone {m.position}</ListHead>
        <StatusBadge status={m.chainStatus} />
      </div>
      <h3 className="mt-3 text-[17px] font-medium tracking-tight">{m.title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-faint">{m.description}</p>

      <div className="mt-5 grid grid-cols-3 gap-4 border-y border-line py-4">
        <div>
          <div className="num text-[11px] uppercase tracking-wider text-faint">value</div>
          <EthAmount wei={m.amountWei} className="mt-1 block text-sm font-medium" />
        </div>
        <div>
          <div className="num text-[11px] uppercase tracking-wider text-faint">fee on release</div>
          <span className="num mt-1 block text-sm text-dim">{formatEth(fee)} ETH</span>
        </div>
        <div>
          <div className="num text-[11px] uppercase tracking-wider text-faint">payout</div>
          <EthAmount wei={toWei(m.amountWei) - fee} className="mt-1 block text-sm text-state-released" />
        </div>
      </div>

      {/* state machine actions */}
      <div className="mt-5 space-y-3">
        {m.chainStatus === "pending_funding" && fundState !== "landed" && (
          <ActionBlock
            icon={<LockKeyOpen className="h-4 w-4" />}
            title={isClient ? "Fund the milestones" : "Awaiting funding"}
            body={
              isClient
                ? "Milestones lock from the job budget in ONE signature at award — if that tx did not land, fund every outstanding milestone now: value is locked until approve, cancel, or arbitration."
                : "The client funds the milestones from the job budget locked at publish; work needs no further signatures from them."
            }
          >
            {isClient && m.fund && address && (
              <Button
                disabled={active || fundState !== "idle"}
                onClick={() => fundAllMilestones()}
                className="w-full rounded-full bg-amber-500 py-3 text-[13px] font-medium text-ink hover:bg-amber-400"
              >
                <PhaseLabel phase={chain.phase} idle={`Fund ${formatEth(outstandingWei)} ETH (all milestones)`} />
              </Button>
            )}
          </ActionBlock>
        )}

        {(m.chainStatus === "funded" || fundState === "landed") && (
          <ActionBlock
            icon={<PaperPlaneTilt className="h-4 w-4" />}
            title={isFreelancer ? "Deliver + submit on-chain" : "In escrow · freelancer working"}
            body={
              isFreelancer
                ? "Record the delivery notes, then flip the state with submit(). The client's review window opens the moment it mines."
                : "Value is locked. The freelancer submits delivery notes and calls submit() when the work is ready for review."
            }
          >
            {fundState === "landed" && (
              <p className="num rounded-2xl border border-state-released/30 bg-state-released/[0.06] px-4 py-3 text-[12px] text-state-released">
                Funding landed on-chain — waiting for the indexer to mirror it.
              </p>
            )}
            {isFreelancer && (
              <div className="space-y-3">
                <Textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
                  placeholder="Delivery notes: what shipped, where to look, what to check before approving."
                  className="resize-none border-line bg-white/[0.03] text-[13px]"
                />
                <Button
                  disabled={active || notes.trim().length < 1}
                  onClick={() =>
                    offscreenSubmit()
                  }
                  className="w-full rounded-full bg-state-submitted py-3 text-[13px] font-medium text-ink hover:brightness-110"
                >
                  <PhaseLabel phase={chain.phase} idle="Record submission + submit()" />
                </Button>
              </div>
            )}
          </ActionBlock>
        )}

        {m.chainStatus === "submitted" && (
          <>
            <ActionBlock
              icon={<CheckCircle className="h-4 w-4" />}
              title={isClient ? "Review window open" : "Submitted · awaiting client review"}
              body={isClient ? "Approve to make the payout claimable — the freelancer then withdraws it with one click. Not right yet? Request changes off-chain, or lock it into dispute." : "The client can approve, request changes, or dispute. You keep the delivery notes as evidence."}
            >
              {isClient && m.onchainId !== null && (
                <div className="space-y-2.5">
                  <Button
                    disabled={active}
                    onClick={() =>
                      chain.run({
                        label: "Approve milestone",
                        contract: "escrow",
                        functionName: "approve",
                        args: [toWei(m.onchainId!)],
                        projectId,
                        expect: wait("released"),
                        successMessage: "Approved: payout is claimable for the freelancer",
                      })
                    }
                    className="w-full rounded-full bg-state-released py-3 text-[13px] font-medium text-ink hover:brightness-110"
                  >
                    <PhaseLabel phase={chain.phase} idle={`Approve · ${formatEth(toWei(m.amountWei) - fee)} ETH claimable`} />
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={active}
                    onClick={async () => {
                      await post(`/projects/${projectId}/milestones/${m.id}/request-changes`, { note: notes.trim() || undefined });
                      invalidate.project(projectId);
                      toast("Changes requested", { description: "Soft state only; the chain stays 'submitted'." });
                    }}
                    className="w-full rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground"
                  >
                    <ArrowClockwise className="mr-2 h-3.5 w-3.5" /> Request changes (off-chain)
                  </Button>
                </div>
              )}
            </ActionBlock>
          </>
        )}

        {["released", "resolved_release", "resolved_split"].includes(m.chainStatus) && !m.withdrawnAt && (
          <ActionBlock
            icon={<HandCoins className="h-4 w-4" />}
            title={isFreelancer ? "Payout ready — withdraw it" : "Payout claimable"}
            body={
              isFreelancer
                ? "The client approved this milestone. One click pulls the principal (minus the platform fee) into your wallet."
                : "Approved and waiting on the freelancer's withdrawal — nothing is required from you."
            }
          >
            {isFreelancer && m.onchainId !== null && (
              <Button
                disabled={active}
                onClick={() =>
                  chain.run({
                    label: "Withdraw payout",
                    contract: "escrow",
                    functionName: "withdrawMilestone",
                    args: [toWei(m.onchainId!)],
                    projectId,
                    expect: (p) => !!p.milestones.find((x) => x.id === m.id)?.withdrawnAt,
                    successMessage: "Withdrawn: payout is in your wallet",
                  })
                }
                className="w-full rounded-full bg-state-released py-3 text-[13px] font-medium text-ink hover:brightness-110"
              >
                <PhaseLabel phase={chain.phase} idle={`Withdraw ${formatEth(toWei(m.amountWei) - fee)} ETH`} />
              </Button>
            )}
          </ActionBlock>
        )}

        {m.withdrawTxHash && (
          <div className="mt-1 flex items-center justify-between border-t border-line pt-3.5">
            <span className="num text-[11px] uppercase tracking-wider text-faint">withdrawal tx</span>
            <HashText value={m.withdrawTxHash} size={8} className="text-[12px] text-state-released" />
          </div>
        )}

        {["funded", "submitted"].includes(m.chainStatus) && (isClient || isFreelancer) && (
          <details className="group border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[13px] text-dim transition-colors hover:text-foreground">
              <Gavel className="h-4 w-4 text-state-disputed" />
              {m.chainStatus === "disputed" ? "Dispute path" : "Can't agree? Open the arbiter path"}
              <span className="ml-auto text-[11px] text-faint group-open:hidden">expand</span>
            </summary>
            <div className="mt-4 space-y-3">
              <p className="text-[12.5px] leading-relaxed text-faint">
                The dispute record (reason) is written off-chain, then your wallet locks the milestone on-chain and pays
                the dispute fee. {preferredArg ? "Your mutually-locked arbiters seat first; " : ""}Any remaining seats
                draw at random from eligible arbiters who vote commit-reveal; a 2-of-3 majority decides.
              </p>
              <Textarea
                value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                placeholder="What exactly is disputed: scope, quality, timeline. This becomes evidence."
                className="resize-none border-line bg-white/[0.03] text-[13px]"
              />
              <p className="num text-[11px] text-faint">
                dispute fee {formatEth(disputeFeeWei)} ETH · paid to the majority arbiters on resolution
              </p>
              {quorumRisk && (
                <p className="num rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-[11.5px] text-amber-200">
                  Only {eligibleSeats} eligible arbiter{eligibleSeats === 1 ? "" : "s"} outside the parties — opening now reverts on-chain (needs {QUORUM}).
                </p>
              )}
              <Button
                disabled={active || reason.trim().length < 10 || m.onchainId === null}
                onClick={() =>
                  offchainThenChain(
                    `/projects/${projectId}/milestones/${m.id}/disputes`,
                    { reason: reason.trim() },
                    () => openDisputeAction(chain.run)(
                      m.onchainId!, toWei(disputeFeeWei), projectId, wait("disputed"),
                      preferredArg ? (preferredArg as [string, string, string]) : undefined,
                    ),
                  )
                }
                className="w-full rounded-full border border-state-disputed/40 bg-state-disputed/10 py-2.5 text-[12.5px] font-medium text-state-disputed hover:bg-state-disputed/20"
              >
                <PhaseLabel phase={chain.phase} idle={`Write record + openDispute() · ${formatEth(disputeFeeWei)} ETH`} />
              </Button>
            </div>
          </details>
        )}

        {dispute && (
          <DisputePanel projectId={projectId} milestone={m} dispute={dispute} wait={wait} />
        )}

        {showReview && (
          <ActionBlock
            icon={<Star className="h-4 w-4" weight={myReview ? "fill" : "regular"} />}
            title={myReview ? "You reviewed this milestone" : "Review the counterparty"}
            body={
              myReview
                ? "Reviews are transaction-bound — the row carries the settlement tx hash."
                : projectComplete
                  ? "One review per side, unlocked now that every milestone of the project is complete and the backend re-verifies settlement via RPC."
                  : "Reviews unlock only once EVERY milestone of the project is complete — this chunk being settled is not enough."
            }
          >
            {!myReview && (isClient || isFreelancer) && projectComplete && <ReviewForm projectId={projectId} milestoneId={m.id} />}
            {!myReview && !projectComplete && (
              <p className="text-[12.5px] text-amber-300">
                {project.milestones.filter((x) => !COMPLETE_STATES.includes(x.chainStatus)).length} milestone(s) still open —
                finish them all to unlock reviews.
              </p>
            )}
            {myReview && (
              <div className="border-y border-line py-4">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star key={n} weight={n <= myReview.rating ? "fill" : "regular"} className={`h-3.5 w-3.5 ${n <= myReview.rating ? "text-amber-300" : "text-faint"}`} />
                  ))}
                  <span className="num ml-2 text-[11px] text-faint">tx {myReview.txHash?.slice(0, 10)}…</span>
                </div>
                {myReview.body && <p className="mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-dim">{myReview.body}</p>}
              </div>
            )}
          </ActionBlock>
        )}
      </div>

      {/* submissions + settlement evidence */}
      {submissions && submissions.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <ListHead>Submissions</ListHead>
          <div className="mt-3 divide-y divide-white/[0.06] border-y border-line">
            {submissions.map((s) => (
              <div key={s.id} className="py-3.5">
                <div className="num text-[11px] text-faint">{timeAgo(s.createdAt)}</div>
                <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-relaxed text-dim">{s.notes}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {m.settlementTxHash && (
        <div className="mt-5 flex items-center justify-between border-t border-line pt-3.5">
          <span className="num text-[11px] uppercase tracking-wider text-faint">settlement tx</span>
          <HashText value={m.settlementTxHash} size={8} className="text-[12px] text-state-released" />
        </div>
      )}

      {chain.error && (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12px] text-destructive">
          <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {chain.error}
        </p>
      )}
    </div>
  );

  async function offscreenSubmit() {
    await offchainThenChain<{ onchainId: number | null }>(
      `/projects/${projectId}/milestones/${m.id}/submissions`,
      { notes: notes.trim(), attachmentIds: [] },
      (posted) => {
        // The server resolve-on-write repairs a missed funding and returns the
        // id — never submit(0) from a stale mirror.
        const onchainId = posted?.onchainId ?? m.onchainId;
        if (onchainId == null) throw new Error("Milestone has no on-chain id yet — the funding may not have landed.");
        return chain.run({
          label: "Submit milestone",
          contract: "escrow",
          functionName: "submit",
          args: [toWei(onchainId)],
          projectId,
          expect: wait("submitted"),
          successMessage: "Submitted on-chain: client review window open",
        });
      },
    );
    setNotes("");
  }
}

/* ── dispute panel (multi-arbiter commit-reveal) ──────────────────────── */

function DisputePanel({
  projectId, milestone, dispute, wait,
}: {
  projectId: string;
  milestone: ProjectMilestone;
  dispute: DisputeView;
  wait: (s: string | string[]) => (p: import("@/lib/types").ProjectView) => boolean;
}) {
  const session = useSession();
  const { address } = useWallet();
  const { data: project } = useProject(projectId);
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const { disputeFeeWei } = useRuntime();
  const round = useRoundState(dispute, milestone.onchainId);
  const windows = useDisputeWindows();
  const now = useNow();
  const [outcome, setOutcome] = useState<keyof typeof DISPUTE_OUTCOME>("split");
  const active = chain.phase !== "idle" && chain.phase !== "done";

  if (!project || milestone.onchainId === null) return null;
  const onchainId = milestone.onchainId;
  const isClient = project.client.id === session.user?.id;
  const isFreelancer = project.freelancer.id === session.user?.id;
  const iAmSelected = round?.arbiters.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const myCommitted = dispute.committedArbiters?.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const myRevealed = dispute.revealedArbiters?.some((a) => a.toLowerCase() === address?.toLowerCase()) ?? false;
  const allRevealed = !!round && round.arbiterCount > 0 && round.revealCount >= round.arbiterCount;
  const canTally = !!round && round.arbiterCount > 0 && !round.resolved && (now > round.revealDeadline || allRevealed);
  // Below quorum the tally is still valid — the contract refunds the opener
  // and returns the milestone to Submitted (no-quorum fallback).
  const tallyFallsBack = !!round && !round.resolved && round.revealCount < QUORUM;
  const canFinalize = !!round && round.resolved && !dispute.finalized && now > round.revealDeadline + windows.appeal;
  // ponytail: derived from the live round + chain windows — the only honest finalize clock.
  const appealEndsAt = round?.resolved && !dispute.finalized ? round.revealDeadline + windows.appeal : null;
  const finalizeInSecs = appealEndsAt !== null ? appealEndsAt - now : 0;
  const phaseLabel = dispute.finalized ? "finalized" : round?.phase ?? dispute.phase;

  return (
    <ActionBlock
      icon={<Scales className="h-4 w-4" />}
      title={dispute.finalized ? "Dispute settled" : round ? `Disputed · ${phaseLabel} phase` : "Dispute opening…"}
      body={dispute.reason}
    >
      <div className="space-y-4">
        {/* Record exists but no on-chain round yet: the opener's tx never
          landed. Nothing votable/tallizable until it does. */}
        {!round && !dispute.finalized && (
          <div className="num rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-[11.5px] text-amber-200">
            Waiting for the on-chain open — {(isClient || isFreelancer) && ["funded", "submitted"].includes(milestone.chainStatus)
              ? "re-send it from “Can't agree? Open the arbiter path” above."
              : "a party still has to send the opening transaction."}
            {(isClient || isFreelancer) && (
              <button
                type="button"
                disabled={active}
                onClick={async () => {
                  try {
                    await del(`/projects/${projectId}/milestones/${milestone.id}/disputes`);
                    invalidate.disputes();
                    toast.success("Record discarded", { description: "No round existed on-chain — post again to retry the open." });
                  } catch (err) {
                    toast.error("Could not discard", { description: err instanceof Error ? err.message : "Unknown error" });
                  }
                }}
                className="mt-1.5 block font-medium underline underline-offset-2 hover:text-amber-100 disabled:opacity-50"
              >
                Discard this record
              </button>
            )}
          </div>
        )}
        {/* phase + clocks */}
        <div className="grid grid-cols-2 gap-2.5 text-center sm:grid-cols-4">
          <Stat label="round" value={String((dispute.round ?? 0) + 1)} />
          <Stat label="arbiters" value={round ? `${round.arbiterCount}` : "—"} />
          <Stat label="committed" value={round ? `${round.commitCount}` : "—"} />
          <Stat label="revealed" value={round ? `${round.revealCount}/${round.arbiterCount}` : "—"} />
        </div>

        {round && !round.resolved && (
          <div className="num rounded-2xl border border-line bg-white/[0.02] px-4 py-3 text-[11.5px] text-faint">
            {round.phase === "commit" && <>commit window closes {timeUntil(new Date(round.commitDeadline * 1000).toISOString())}</>}
            {round.phase === "reveal" && now <= round.revealDeadline && <>reveal window closes {timeUntil(new Date(round.revealDeadline * 1000).toISOString())}</>}
            {round.phase === "reveal" && now > round.revealDeadline && <>reveal window closed — tally is available</>}
            {round.revealCount < round.arbiterCount && round.phase === "reveal" && (
              <span className="text-amber-300"> · waiting on {round.arbiterCount - round.revealCount} arbiter(s)</span>
            )}
          </div>
        )}

        {/* selected arbiters + reveals */}
        {round && round.arbiters.length > 0 && (
          <div className="space-y-1.5">
            <div className="num text-[11px] uppercase tracking-wider text-faint">selected arbiters</div>
            <div className="flex flex-wrap gap-2">
              {round.arbiters.map((a) => {
                const committed = (dispute.committedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
                const revealed = (dispute.revealedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
                return (
                  <span key={a} className={`num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${revealed ? "border-state-released/40 text-state-released" : committed ? "border-white/15 text-dim" : "border-line text-faint"}`}>
                    {shortAddress(a, 4)}
                    <span className="text-[10px] opacity-70">{revealed ? "revealed" : committed ? "committed" : "pending"}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* live tally */}
        {round && (round.revealCount > 0 || dispute.finalized) && (
          <div className="grid grid-cols-3 gap-2 text-center">
            {(["Release", "Refund", "Split"] as const).map((label, i) => (
              <div key={label} className="rounded-xl border border-line bg-white/[0.02] px-3 py-2">
                <div className="num text-[11px] uppercase tracking-wider text-faint">{label}</div>
                <div className="num mt-0.5 text-[16px]">{round.tally[i] ?? 0}</div>
              </div>
            ))}
          </div>
        )}

        {/* arbiter voting */}
        {iAmSelected && !dispute.finalized && round && (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-rose-bright">
              <HandCoins className="h-4 w-4" /> You are a selected arbiter
            </div>

            {round.phase === "commit" && (
              <>
                <p className="text-[11.5px] leading-relaxed text-faint">
                  Choose your ruling and commit the hash now. Your choice stays hidden until the reveal phase — this
                  prevents anyone copying a vote.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(["release", "refund", "split"] as const).map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setOutcome(o)}
                      className={`rounded-full border px-3 py-2 text-[12px] font-medium ${press} ${outcome === o ? "border-rose-accent bg-rose-soft text-foreground" : "border-line text-dim hover:text-foreground"}`}
                    >
                      {o === "split" ? "Split 50/50" : o}
                    </button>
                  ))}
                </div>
                <Button
                  disabled={active || myCommitted}
                  onClick={async () => {
                    const salt = makeSalt();
                    const hash = computeCommitHash(DISPUTE_OUTCOME[outcome], salt, address!, toWei(onchainId), dispute.round ?? 0);
                    const result = await commitVoteAction(chain.run)(onchainId, dispute.round ?? 0, hash, projectId);
                    if (result.ok) {
                      // Stash the salt so the reveal step can find it; losing it
                      // means the commit can't be revealed.
                      saveCommit(dispute.id, dispute.round ?? 0, outcome, salt);
                      invalidate.disputes();
                    }
                  }}
                  className="w-full rounded-full bg-rose-accent py-2.5 text-[12.5px] font-medium text-white hover:bg-rose-bright"
                >
                  <PhaseLabel phase={chain.phase} idle={myCommitted ? "Committed — wait for reveal" : `Commit "${outcome === "split" ? "Split 50/50" : outcome}"`} />
                </Button>
              </>
            )}

            {round.phase === "reveal" && !myRevealed && now <= round.revealDeadline && (
              <>
                <p className="text-[11.5px] leading-relaxed text-faint">
                  Reveal must match your commit exactly (same outcome + salt) — otherwise the transaction reverts.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(["release", "refund", "split"] as const).map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setOutcome(o)}
                      className={`rounded-full border px-3 py-2 text-[12px] font-medium ${press} ${outcome === o ? "border-rose-accent bg-rose-soft text-foreground" : "border-line text-dim hover:text-foreground"}`}
                    >
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
                      toast.error("Outcome differs from your commit", { description: `You committed “${saved.outcome}” — switched back for you.` });
                      setOutcome(saved.outcome as keyof typeof DISPUTE_OUTCOME);
                      return;
                    }
                    const result = await revealVoteAction(chain.run)(
                      onchainId, dispute.round ?? 0, DISPUTE_OUTCOME[outcome], saved.salt, projectId,
                    );
                    if (result.ok) {
                      clearCommit(dispute.id, dispute.round ?? 0);
                      invalidate.disputes();
                    }
                  }}
                  className="w-full rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium text-foreground hover:bg-white/20"
                >
                  <PhaseLabel phase={chain.phase} idle={`Reveal "${outcome === "split" ? "Split 50/50" : outcome}"`} />
                </Button>
              </>
            )}

            {myRevealed && <p className="text-[12px] text-state-released">Your vote is revealed. Waiting for the tally.</p>}
          </div>
        )}

        {/* tally + finalize (permissionless) */}
        {!dispute.finalized && (
          <div className="space-y-2.5 border-t border-line pt-4">
            {(isClient || isFreelancer) && round?.resolved && !dispute.finalized && (
              <p className="text-[11.5px] text-faint">
                A party may still appeal within the window; otherwise anyone can finalize the payout.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                disabled={active || !canTally}
                onClick={async () => {
                  const result = await tallyDisputeAction(chain.run)(onchainId, dispute.round ?? 0, projectId);
                  if (result.ok) invalidate.disputes();
                }}
                className="rounded-full bg-white/10 py-2.5 text-[12px] font-medium hover:bg-white/20"
              >
                Tally round
              </Button>
              <Button
                disabled={active || !canFinalize}
                onClick={async () => {
                  const result = await finalizeDisputeAction(chain.run)(onchainId, projectId, wait(["resolved_release", "resolved_refund", "resolved_split"]));
                  if (result.ok) { invalidate.disputes(); invalidate.overview(); }
                }}
                className="rounded-full bg-state-released/15 py-2.5 text-[12px] font-medium text-state-released hover:bg-state-released/25"
              >
                {finalizeInSecs > 0 ? `Finalize ${timeUntil(new Date(appealEndsAt! * 1000).toISOString())}` : "Finalize payout"}
              </Button>
            </div>
            {finalizeInSecs > 0 && (
              <p className="text-[11.5px] text-faint">Payout unlocks once the appeal window closes — anyone can finalize then.</p>
            )}
            {canTally && tallyFallsBack && (
              <p className="text-[11.5px] text-amber-300">Fewer than {QUORUM} reveals — tallying refunds the opener and returns the milestone to Submitted (no-quorum fallback).</p>
            )}
            {(isClient || isFreelancer) && round?.resolved && !dispute.finalized && (
              <Button
                disabled={active}
                onClick={async () => {
                  const result = await appealDisputeAction(chain.run)(onchainId, toWei(disputeFeeWei), projectId);
                  if (result.ok) invalidate.disputes();
                }}
                className="w-full rounded-full border border-state-disputed/40 py-2 text-[12px] font-medium text-state-disputed hover:bg-state-disputed/10"
              >
                Appeal ({formatEth(disputeFeeWei)} ETH) — penalises a wrong majority
              </Button>
            )}
          </div>
        )}

        {dispute.finalized && (
          <div className="flex items-center gap-2 border-t border-line pt-4 text-[12.5px] text-state-split">
            <SealCheck weight="fill" className="h-4 w-4" />
            Settled — {dispute.outcome ?? "—"} · majority {dispute.majorityArbiters?.length ?? 0} arbiter(s)
          </div>
        )}
      </div>
    </ActionBlock>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2">
      <div className="num text-[10.5px] uppercase tracking-wider text-faint">{label}</div>
      <div className="num mt-0.5 text-[14px]">{value}</div>
    </div>
  );
}

/* ── review form ───────────────────────────────────────────────────────── */

function ReviewForm({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const invalidate = useInvalidate();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} stars`} className={press}>
            <Star weight={n <= rating ? "fill" : "regular"} className={`h-5 w-5 ${n <= rating ? "text-amber-300" : "text-faint"}`} />
          </button>
        ))}
      </div>
      <Textarea
        value={body} onChange={(e) => setBody(e.target.value)} rows={2}
        placeholder="How did this milestone actually go?"
        className="resize-none border-line bg-white/[0.03] text-[13px]"
      />
      <Button
        disabled={submitting}
        onClick={async () => {
          setSubmitting(true);
          try {
            await post(`/milestones/${milestoneId}/reviews`, { rating, body: body.trim() || undefined });
            invalidate.reviews(milestoneId, projectId);
            invalidate.overview();
            toast.success("Review recorded", { description: "Bound to the settlement transaction." });
          } catch (err) {
            toast.error("Review rejected", { description: err instanceof Error ? err.message : "Unknown error" });
          } finally {
            setSubmitting(false);
          }
        }}
        className="w-full rounded-full bg-white/10 py-2.5 text-[12.5px] font-medium text-foreground hover:bg-white/20"
      >
        Publish review
      </Button>
    </div>
  );
}

/* ── chat tab ──────────────────────────────────────────────────────────── */

function ChatTab({ projectId }: { projectId: string }) {
  const { data: messages } = useMessages(projectId);
  const { data: project } = useProject(projectId);
  const session = useSession();
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages?.length]);

  const canPost = project && (project.client.id === session.user?.id || project.freelancer.id === session.user?.id);

  // Assigned arbiters read the room but not the chat: the messages endpoint
  // stays participant-only, so say so instead of faking an empty thread.
  if (project && !canPost) {
    return (
      <div className="glass rounded-3xl px-6 py-14 text-center text-sm text-faint">
        Messages are participant-only — arbiters judge from milestones, submissions, and on-chain activity.
      </div>
    );
  }

  return (
    <div className="glass flex h-[560px] flex-col rounded-3xl">
      <div className="flex items-center gap-2.5 border-b border-line px-6 py-4">
        <ChatCircleDots className="h-4 w-4 text-faint" />
        <span className="text-[13px] text-dim">Project chat — append-only evidence</span>
        <span className="num ml-auto text-[11px] text-faint">edits and deletes are structurally impossible</span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {!messages?.length && (
          <p className="pt-16 text-center text-sm text-faint">No messages yet. Coordinate scope, funding, and reviews here — the record is permanent.</p>
        )}
        {messages?.map((msg) => {
          const mine = msg.senderId === session.user?.id;
          const sender = msg.senderId === project?.client.id ? project.client : project?.freelancer;
          return (
            <div key={msg.id} className="border-t border-line pt-3.5 first:border-t-0 first:pt-0">
              <div className="flex items-baseline gap-2.5">
                <span className={`text-[12px] font-medium ${mine ? "text-rose-bright" : "text-foreground"}`}>
                  {sender?.displayName ?? "member"}
                </span>
                <span className="num text-[11px] text-faint">{timeAgo(msg.createdAt)}</span>
                {mine && <span className="text-[11px] text-faint">you</span>}
              </div>
              <p className="mt-1 max-w-[72ch] text-[13.5px] leading-relaxed text-dim">{msg.body}</p>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {canPost ? (
        <form
          className="flex items-center gap-3 border-t border-line px-5 py-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim() || sending) return;
            setSending(true);
            try {
              await post(`/projects/${projectId}/messages`, { body: draft.trim() });
              setDraft("");
              invalidate.messages(projectId);
            } catch (err) {
              toast.error("Message failed", { description: err instanceof Error ? err.message : "Unknown error" });
            } finally {
              setSending(false);
            }
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message the counterparty…"
            className="h-11 flex-1 rounded-full border border-line bg-white/[0.03] px-5 text-sm outline-none placeholder:text-faint focus:border-rose-accent/50"
          />
          <Button type="submit" disabled={!draft.trim() || sending} className="h-11 rounded-full bg-rose-accent px-5 hover:bg-rose-bright">
            <PaperPlaneTilt className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="border-t border-line px-6 py-4 text-[12px] text-faint">Participants only.</div>
      )}
    </div>
  );
}

/* ── activity tab ─────────────────────────────────────────────────────── */

function ActivityTab({ projectId }: { projectId: string }) {
  const { data: ledger } = useLedger({ projectId, limit: "50" });
  const { data: project } = useProject(projectId);

  return (
    <div className="glass overflow-hidden rounded-3xl">
      <div className="flex items-center gap-2.5 border-b border-line px-6 py-4">
        <Pulse className="h-4 w-4 text-faint" />
        <span className="text-[13px] text-dim">On-chain events for this project</span>
        <span className="num ml-auto text-[11px] text-faint">event-sourced cache · links carry real tx hashes</span>
      </div>
      {!ledger?.items.length ? (
        <p className="px-6 py-14 text-center text-sm text-faint">No chain events yet — fund a milestone to see the indexer work.</p>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {ledger.items.map((e) => {
            const payloadAmount = (e.payload as Record<string, string>)?.amount;
            const payloadFee = (e.payload as Record<string, string>)?.fee;
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-6 py-4">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATE_COLORS.eventType?.[e.eventType] ?? "#f43f5e" }} />
                <span className="min-w-0 flex-1">
                  <span className="text-[13.5px] text-foreground">{e.eventType}</span>
                  {e.milestoneOnchainId !== null && (
                    <span className="num ml-2 text-[11px] text-faint">milestone #{e.milestoneOnchainId}</span>
                  )}
                  {payloadAmount && <span className="num ml-2 text-[11px] text-dim">{formatEth(payloadAmount)} ETH</span>}
                  {payloadFee && toWei(payloadFee) > 0n && <span className="num ml-2 text-[11px] text-state-split">fee {formatEth(payloadFee)}</span>}
                </span>
                <span className="num text-[11px] text-faint">block {e.blockNumber}</span>
                <HashText value={e.txHash} size={5} className="text-[11.5px]" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── shared bits ──────────────────────────────────────────────────────── */

function ActionBlock({ icon, title, body, children }: { icon: React.ReactNode; title: string; body?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-5">
      <div className="flex items-center gap-2.5">
        <span className="text-rose-bright">{icon}</span>
        <span className="text-[13.5px] font-medium">{title}</span>
      </div>
      {typeof body === "string" ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-faint">{body}</p>
      ) : body ? (
        <div className="mt-2 text-[12.5px] leading-relaxed text-faint">{body}</div>
      ) : null}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

function PhaseLabel({ phase, idle }: { phase: string; idle: string }) {
  return (
    <span className="flex items-center justify-center gap-2">
      <AnimatePresence mode="wait">
        <motion.span
          key={phase}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.14 }}
          className="flex items-center gap-2"
        >
          {phase === "signing" && <Coins className="h-3.5 w-3.5 animate-pulse" />}
          {phase === "mining" && <ArrowClockwise className="h-3.5 w-3.5 animate-spin" />}
          {phase === "indexing" && <SealCheck className="h-3.5 w-3.5 animate-pulse text-amber-300" />}
          {phase === "idle" || phase === "done" ? idle : phase === "signing" ? "Waiting for signature…" : phase === "mining" ? "Mining…" : "Indexer mirroring…"}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
