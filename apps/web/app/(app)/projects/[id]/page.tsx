"use client";

/**
 * /projects/:id — THE PROJECT ROOM.
 * Milestone state machine + wallet actions + chat + on-chain activity.
 * Every money movement: wallet signs → tx mines → indexer mirrors (three-phase
 * honest UX: signing / mining / indexing).
 */
import { use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet";
import { AnimatePresence, motion } from "framer-motion";
import {
  useProject, useJob, useMessages, useSubmissions, useMilestoneReviews, useDisputes, useArbiters,
  useLedger, useInvalidate, post, patch,
} from "@/lib/queries";
import { useSession } from "@/lib/session";
import { del } from "@/lib/api";
import { uploadAttachment } from "@/lib/uploads";
import { AttachmentChip } from "@/components/attachment-chip";
import { AttachmentPicker } from "@/components/attachment-picker";
import {
  useChainAction, openDisputeAction, commitVoteAction, revealVoteAction, tallyDisputeAction,
  finalizeDisputeAction, appealDisputeAction, readJobBudget,
} from "@/lib/chain-actions";
import { computeCommitHash, makeSalt } from "@/lib/dispute-round";
import { DISPUTE_OUTCOME, MAX_ARBITERS, MIN_ARBITERS, QUORUM, requiredReveals } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import {
  AddressAvatar, AddressText, EthAmount, HashText, ListHead, Skeleton, EmptyState, press,
  StatusBadge, Copyable,
} from "@/components/design";
import { STATE_COLORS, MILESTONE_LABELS, clockTime, formatEth, toWei, shortAddress, timeAgo, timeUntil, feeOn, ledgerDotColor } from "@/lib/format";
import type { MessageView, ProjectMilestone, DisputeView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArbiterPickerDialog } from "@/components/arbiter-picker-dialog";
import { ArbiterBubbles } from "@/components/arbiter-bubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SurplusPanel } from "@/components/surplus-panel";
import { DisputePanel } from "@/components/dispute-panel";
import { LockKeyOpen } from "@phosphor-icons/react/dist/csr/LockKeyOpen";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { ChatCircleDots } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Checks } from "@phosphor-icons/react/dist/csr/Checks";
import { Pulse } from "@phosphor-icons/react/dist/csr/Pulse";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { HandCoins } from "@phosphor-icons/react/dist/csr/HandCoins";

export default function ProjectRoomPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = use(params);
  const session = useSession();
  const { data: project, isLoading } = useProject(id);
  // The client's free budget lives on the job's escrow key; react-query shares
  // the entry with ProjectHeader, so this costs nothing extra.
  const { data: job } = useJob(project?.jobId ?? "");
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
      {/* The room is where an awarded job lives, so it is also where the client
          finds the free budget — the job posting redirects here on award. It
          renders nothing once the award handed the surplus back. */}
      {isClient && job && <SurplusPanel jobId={job.id} jobRef={job.jobRef} />}
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
    if (addresses.length < MIN_ARBITERS || addresses.length > MAX_ARBITERS) {
      toast.error(`Pick ${MIN_ARBITERS}–${MAX_ARBITERS} arbiters`, {
        description: "Whoever you lock is the panel — one is enough, and nobody outside it is ever asked.",
      });
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
      toast.success("Arbiters locked", { description: "They are the panel — nobody outside it is ever asked." });
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
          <p className="text-[12px] text-faint">They are the panel, and nobody outside this list is ever asked. Fewer than 3 seats a degraded round that decides on those votes alone.</p>
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
          {!isParty && !proposal && (
            <p className="text-[12px] text-faint">No arbiters picked yet — the parties agree {MIN_ARBITERS}–{MAX_ARBITERS} after award.</p>
          )}
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
  const { feeBps, disputeFeeWei, escrow, chainMode, storage } = useRuntime();
  // The server's evidence ceiling, not a local copy — the API refuses past it.
  const maxAttachments = storage?.maxAttachments ?? 3;
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  /** The client's revision request — its own field, never the delivery notes. */
  const [changeNote, setChangeNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Mirror-lag guard: once the chain says funded while the mirror still says
  // pending, the Fund button stays dead until the indexer catches up.
  const [fundState, setFundState] = useState<"idle" | "landed">("idle");
  // Every milestone still sitting at pending_funding — funded together in one tx.
  // Derived before the early return so the stale-mirror effect below can use it.
  const outstanding = (project?.milestones ?? []).filter((x) => x.chainStatus === "pending_funding" && x.fund);
  const outstandingWei = outstanding.reduce((acc, x) => acc + BigInt(x.fund?.amountWei ?? "0"), 0n);
  const outstandingJobRef = outstanding[0]?.fund?.jobRef ?? outstanding[0]?.fund?.ref ?? null;
  const cardStatus = m.chainStatus;
  // Request-changes is an off-chain soft state: the chain stays `submitted`, so
  // this is what tells the freelancer the work is back with them. It is also the
  // only thing that makes a second submission legal (the API keys the revision
  // branch off exactly this pair).
  const changesRequested = m.softStatus === "changes_requested" && m.chainStatus === "submitted";

  // Stale-mirror check: a mined funding tx can leave the mirror at
  // pending_funding (indexer lag/outage) while work has already started. Chain
  // budget is truth — when it can't cover the outstanding sum, funding landed:
  // hide Fund and show the waiting notice without needing a click first.
  //
  // It re-reads on every render of the project data instead of latching on the
  // first answer. The latch was correct when a hard refresh was the only exit;
  // now that the view updates itself it is a bug — "landed" describes the chain
  // right now, so the mirror catching up has to be able to retire it on its
  // own. `project` is a fresh object each poll, which is the re-read trigger.
  useEffect(() => {
    if (!escrow || !outstandingJobRef || cardStatus !== "pending_funding") {
      setFundState("idle");
      return;
    }
    let cancelled = false;
    readJobBudget(escrow, outstandingJobRef)
      .catch(() => null)
      .then((budget) => {
        if (cancelled) return;
        setFundState(budget && outstandingWei > budget.free ? "landed" : "idle");
      });
    return () => { cancelled = true; };
    // `project` is the poll tick: it changes identity on every refetch, which is
    // exactly the re-read this effect wants — not an exhaustive-deps oversight.
  }, [project, escrow, outstandingJobRef, outstandingWei, cardStatus]);

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
  // Live dispute fee from the contract (0 = free). Copy and the tx value both
  // branch on it, so a fee retune is picked up without a code change.
  const feeWei = toWei(disputeFeeWei);
  const active = chain.active;
  // The locked panel IS the dispute panel on-chain (no top-up); without a lock
  // the contract draws all 3 at random. Zero-padded to the fixed-size arg.
  const lockedPreferred = ((project.chosenArbiters ?? []) as string[]).filter(Boolean).slice(0, MAX_ARBITERS);
  const preferredArg = lockedPreferred.length > 0
    ? [...lockedPreferred, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR].slice(0, MAX_ARBITERS)
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
      const budget = await readJobBudget(escrow, jobRef).catch(() => null);
      if (budget && outstandingWei > budget.free) {
        setFundState("landed");
        toast.success("Already funded on-chain", {
          description: "The funding transaction landed — this view updates itself as soon as the indexer mirrors it.",
        });
        invalidate.project(projectId);
        invalidate.overview();
        return;
      }
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

  /**
   * Record off-chain, then flip the chain — the shape every money action takes.
   *
   * `chainCall` may return `null` to say "this act is off-chain only" (a
   * revision re-records a delivery against a milestone the chain already holds
   * as Submitted, so there is no transaction to send). That is a success, not a
   * skip: the record is written and the views still need invalidating.
   *
   * Returns whether the record landed. The error is toasted here, so a caller
   * that clears a form afterwards has to know it survived — otherwise a failed
   * post silently discards what the user typed.
   */
  async function offchainThenChain<T>(
    path: string,
    body: unknown,
    chainCall: (posted: T | null) => { ok: boolean } | null | Promise<{ ok: boolean } | null>,
  ): Promise<boolean> {
    try {
      const posted = path ? await post<T>(path, body) : null;
      const result = await chainCall(posted);
      if (result === null || result.ok) {
        invalidate.project(projectId);
        invalidate.submissions();
        invalidate.disputes();
        invalidate.overview();
        return true;
      }
      return false;
    } catch (err) {
      toast.error("Action failed", { description: err instanceof Error ? err.message : "Unknown error" });
      return false;
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

        {(m.chainStatus === "funded" || fundState === "landed" || changesRequested) && (
          <ActionBlock
            icon={<PaperPlaneTilt className="h-4 w-4" />}
            title={
              changesRequested
                ? isFreelancer ? "Changes requested — revise and resubmit" : "Waiting on the revised delivery"
                : isFreelancer ? "Deliver + submit on-chain" : "In escrow · freelancer working"
            }
            body={
              changesRequested
                ? "Answer the note below with a fresh delivery record. No second transaction — the milestone is already submitted on-chain and only the client can move it from here."
                : isFreelancer
                  ? "Record the delivery notes, then flip the state with submit(). The client's review window opens the moment it mines."
                  : "Value is locked. The freelancer submits delivery notes and calls submit() when the work is ready for review."
            }
          >
            {fundState === "landed" && (
              <p className="num rounded-2xl border border-state-released/30 bg-state-released/[0.06] px-4 py-3 text-[12px] text-state-released">
                Funding landed on-chain — waiting for the indexer to mirror it.
              </p>
            )}
            {changesRequested && m.softStatusNote && (
              <p className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3 text-[12.5px] leading-relaxed text-amber-200">
                <span className="num block text-[11px] uppercase tracking-wider text-amber-300/80">Client asks for</span>
                {m.softStatusNote}
              </p>
            )}
            {isFreelancer && (
              <div className="space-y-3">
                <Textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
                  placeholder={
                    changesRequested
                      ? "What changed since the last delivery, and what the client should look at now."
                      : "Delivery notes: what shipped, where to look, what to check before approving."
                  }
                  className="text-[13px]"
                />
                <SubmissionFiles files={files} onChange={setFiles} max={maxAttachments} />
                {submitError && (
                  <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">
                    <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {submitError}
                  </p>
                )}
                <Button
                  disabled={active || notes.trim().length < 1}
                  onClick={() => offscreenSubmit()}
                  className="w-full rounded-full bg-state-submitted py-3 text-[13px] font-medium text-ink hover:brightness-110"
                >
                  <PhaseLabel
                    phase={chain.phase}
                    idle={changesRequested ? "Record revision" : "Record submission + submit()"}
                  />
                </Button>
              </div>
            )}
          </ActionBlock>
        )}

        {m.chainStatus === "submitted" && (
          <>
            <ActionBlock
              icon={<CheckCircle className="h-4 w-4" />}
              title={
                changesRequested
                  ? isClient ? "Waiting on the revision" : "Revising — your note is with the client"
                  : isClient ? "Review window open" : "Submitted · awaiting client review"
              }
              body={
                changesRequested
                  ? "The milestone stays submitted on-chain while the delivery is revised, so you can still approve what landed or open a dispute."
                  : isClient
                    ? "Approve to make the payout claimable — the freelancer then withdraws it with one click. Not right yet? Request changes off-chain, or lock it into dispute."
                    : "The client can approve, request changes, or dispute. You keep the delivery notes as evidence."
              }
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
                  {!changesRequested && (
                    <>
                      <Textarea
                        value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={3}
                        placeholder="What needs to change. This is the note the freelancer revises against — say it precisely."
                        className="text-[13px]"
                      />
                      <Button
                        variant="ghost"
                        disabled={active || changeNote.trim().length < 3}
                        onClick={async () => {
                          try {
                            await post(`/projects/${projectId}/milestones/${m.id}/request-changes`, { note: changeNote.trim() });
                            setChangeNote("");
                            invalidate.project(projectId);
                            toast("Changes requested", { description: "Soft state only; the chain stays 'submitted'." });
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Could not request changes");
                          }
                        }}
                        className="w-full rounded-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground"
                      >
                        <ArrowClockwise className="mr-2 h-3.5 w-3.5" /> Request changes (off-chain)
                      </Button>
                    </>
                  )}
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
                The dispute record (reason) is written off-chain, then your wallet locks the milestone on-chain
                {feeWei > 0n ? " and pays the dispute fee" : " — opening is free"}. {preferredArg ? "Your mutually-locked arbiters seat first; " : ""}Any remaining seats
                draw at random from eligible arbiters who vote commit-reveal; a majority decides.
              </p>
              <Textarea
                value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                placeholder="What exactly is disputed: scope, quality, timeline. This becomes evidence."
                className="text-[13px]"
              />
              <p className="num text-[11px] text-faint">
                {feeWei > 0n
                  ? `dispute fee ${formatEth(disputeFeeWei)} ETH · paid to the majority arbiters on resolution`
                  : "free to open · the protocol's reward pool pays the arbiters"}
              </p>
              {quorumRisk && (
                <p className="num rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-[11.5px] text-amber-200">
                  {eligibleSeats === 0
                    ? `No eligible arbiter outside the parties right now — opening reverts on-chain until one registers (needs at least 1${QUORUM > 1 ? `, ${QUORUM} for a full panel` : ""}).`
                    : `Only ${eligibleSeats} eligible arbiter${eligibleSeats === 1 ? "" : "s"} outside the parties — this round is a degraded panel, decided by a single vote instead of ${QUORUM}-of-3.`}
                </p>
              )}
              <Button
                disabled={active || reason.trim().length < 10 || m.onchainId === null}
                onClick={() =>
                  offchainThenChain(
                    `/projects/${projectId}/milestones/${m.id}/disputes`,
                    { reason: reason.trim() },
                    () => openDisputeAction(chain.run)(
                      m.onchainId!, feeWei, projectId, wait("disputed"),
                      preferredArg ? (preferredArg as [string, string, string]) : undefined,
                    ),
                  )
                }
                className="w-full rounded-full border border-state-disputed/40 bg-state-disputed/10 py-2.5 text-[12.5px] font-medium text-state-disputed hover:bg-state-disputed/20"
              >
                <PhaseLabel phase={chain.phase} idle={`Write record + openDispute()${feeWei > 0n ? ` · ${formatEth(disputeFeeWei)} ETH` : " · free"}`} />
              </Button>
            </div>
          </details>
        )}

        {dispute && (
          <ActionBlock
            icon={<Scales className="h-4 w-4" />}
            title={dispute.finalized ? "Dispute settled" : "Dispute in progress"}
            body={dispute.reason}
          >
            <DisputePanel dispute={dispute} />
          </ActionBlock>
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
                  {myReview.txHash && <span className="num ml-2 text-[11px] text-faint">tx {myReview.txHash.slice(0, 10)}…</span>}
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
            {submissions.map((s, i) => (
              <div key={s.id} className="py-3.5">
                <div className="num text-[11px] text-faint">
                  {timeAgo(s.createdAt)}
                  {/* Revisions are the deliveries after a request-changes. The
                      newest is first, so the top entry is the live one and a
                      later "changes requested" note explains the one below. */}
                  {i === 0 && changesRequested && <span className="text-amber-300"> · awaiting revision</span>}
                </div>
                <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-relaxed text-dim">{s.notes}</p>
                {s.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.attachments.map((a) => <AttachmentChip key={a.id} attachment={a} />)}
                  </div>
                )}
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
    setSubmitError(null);
    try {
      // Files are project-scoped, so they exist before the submission can name
      // them: upload first, then post the record with the ids it returns. A
      // failed upload aborts before any record or tx exists — the milestone
      // simply stays in the state it was in.
      const attachmentIds: string[] = [];
      for (const f of files) {
        const uploaded = await uploadAttachment(`/projects/${projectId}`, f);
        attachmentIds.push(uploaded.id);
      }
      const landed = await offchainThenChain<{ onchainId: number | null; onchainActionRequired: string | null }>(
        `/projects/${projectId}/milestones/${m.id}/submissions`,
        { notes: notes.trim(), attachmentIds },
        async (posted) => {
          // A revision owes the chain nothing — the milestone is already
          // Submitted and submit() would revert. The server says which it was.
          if (posted?.onchainActionRequired == null) {
            toast.success("Revision recorded", { description: "The client sees it immediately — no new transaction." });
            return null;
          }
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
      // Only clear on success: a failed record is still in the box, and the
      // files are already uploaded so re-posting must not duplicate them.
      if (landed) {
        setNotes("");
        setFiles([]);
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Submission failed");
    }
  }
}

/**
 * The delivery's evidence picker. Same component the propose form uses — the
 * cap comes from the server's storage config, so the counter and the 400 can
 * never disagree.
 */
function SubmissionFiles({ files, onChange, max }: { files: File[]; onChange: (f: File[]) => void; max: number }) {
  return (
    <AttachmentPicker
      files={files}
      onChange={onChange}
      max={max}
      label="Evidence"
      emptyLabel="Attach the build, the diff, the recording"
      hint="The client opens these while reviewing. The delivery notes say what to look at."
    />
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
        className="text-[13px]"
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

/**
 * Consecutive messages from one sender collapse into a single visual run, the
 * way a messenger groups a held-down thumb. Five minutes is the cut: past that
 * the name and a gap come back, because the two messages are a new utterance.
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function isRunStart(list: MessageView[], index: number): boolean {
  const cur = list[index]!;
  const prev = list[index - 1];
  if (!prev) return true;
  if (prev.senderId !== cur.senderId) return true;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() > GROUP_WINDOW_MS;
}

function MessageBubble({
  msg, mine, senderName, runStart,
}: { msg: MessageView; mine: boolean; senderName: string; runStart: boolean }) {
  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start", runStart ? "mt-3 first:mt-0" : "mt-1")}>
      <div className={cn("max-w-[min(560px,78%)]", mine && "text-right")}>
        {runStart && !mine && <p className="mb-1 px-1 text-[11px] text-faint">{senderName}</p>}
        <div
          className={cn(
            "inline-block rounded-2xl px-3.5 py-2 text-left text-[13.5px] leading-relaxed",
            mine
              ? "rounded-br-md border border-rose-accent/25 bg-rose-soft text-foreground"
              : "rounded-bl-md border border-line-strong bg-white/[0.045] text-dim",
          )}
        >
          {msg.body}
          <span className="num ml-2 inline-flex items-center gap-1 align-middle text-[11px] text-faint">
            {clockTime(msg.createdAt)}
            {mine && (
              msg.readByOther
                ? <><Checks weight="bold" aria-hidden className="h-3 w-3 text-rose-bright" /><span className="sr-only">read</span></>
                : <><Check aria-hidden className="h-3 w-3" /><span className="sr-only">sent</span></>
            )}
          </span>
        </div>
      </div>
    </li>
  );
}

function ChatTab({ projectId }: { projectId: string }) {
  const { data: messages } = useMessages(projectId);
  const { data: project } = useProject(projectId);
  const session = useSession();
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  /**
   * The pane fills the viewport instead of a fixed 560px, so the chat stops
   * being a letterbox. What sits above it is conditional (the surplus panel is
   * client-only, the arbiter panel only appears once arbiters are seated), so
   * the offset is measured rather than guessed — a `calc(100dvh - 20rem)` is
   * wrong in at least one of those states. `main` reserves 7rem below lg and
   * 4rem at lg+, and those are the numbers to subtract at the bottom.
   */
  useLayoutEffect(() => {
    const measure = () => {
      const pane = paneRef.current;
      if (!pane) return;
      const docTop = pane.getBoundingClientRect().top + window.scrollY;
      const reserve = window.matchMedia("(min-width: 1024px)").matches ? 64 : 112;
      const next = Math.max(360, Math.round(window.innerHeight - docTop - reserve));
      setPaneHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // Only follow the tail when the reader is already there. Without this a
  // message arriving while you read history yanks you to the bottom.
  const stickToBottom = () => {
    const el = threadRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    if (!atBottom.current) return;
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages?.length, paneHeight]);

  // Mark read through the newest message actually rendered, debounced so a
  // burst of polls is one write rather than one per 4s tick. No refetch after:
  // what I just wrote is *my* cursor, and my own bubbles report the
  // counterparty's — the 4s poll already picks that up.
  const canPostHere = !!project && (project.client.id === session.user?.id || project.freelancer.id === session.user?.id);
  const newest = messages?.[messages.length - 1]?.createdAt;
  useEffect(() => {
    if (!newest || !canPostHere) return;
    const t = setTimeout(() => {
      post(`/projects/${projectId}/messages/read`, { through: newest })
        .catch(() => { /* a lost receipt re-lands on the next poll */ });
    }, 800);
    return () => clearTimeout(t);
  }, [newest, projectId, canPostHere]);

  // Assigned arbiters read the room but not the chat: the messages endpoint
  // stays participant-only, so say so instead of faking an empty thread.
  if (project && !canPostHere) {
    return (
      <div className="glass rounded-3xl px-6 py-14 text-center text-sm text-faint">
        Messages are participant-only — arbiters judge from milestones, submissions, and on-chain activity.
      </div>
    );
  }

  return (
    <div ref={paneRef} className="glass flex flex-col overflow-hidden rounded-3xl" style={{ height: paneHeight ?? 560 }}>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-6 py-3.5">
        <ChatCircleDots className="h-4 w-4 text-faint" />
        <span className="text-[13px] text-dim">Project chat</span>
        <span className="num ml-auto text-[11px] text-faint">append-only · reads are a cursor, not an edit</span>
      </div>
      <div
        ref={threadRef}
        onScroll={stickToBottom}
        role="log"
        aria-live="polite"
        aria-label="Project messages"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {!messages?.length ? (
          <p className="pt-16 text-center text-sm text-faint">No messages yet. Coordinate scope, funding, and reviews here — the record is permanent.</p>
        ) : (
          <ol>
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                mine={msg.senderId === session.user?.id}
                senderName={(msg.senderId === project?.client.id ? project.client : project?.freelancer)?.displayName ?? "member"}
                runStart={isRunStart(messages, i)}
              />
            ))}
          </ol>
        )}
      </div>
      {canPostHere ? (
        <form
          className="flex shrink-0 items-end gap-3 border-t border-line px-4 py-3.5 sm:px-5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim() || sending) return;
            setSending(true);
            try {
              await post(`/projects/${projectId}/messages`, { body: draft.trim() });
              setDraft("");
              if (composerRef.current) composerRef.current.style.height = "auto";
              atBottom.current = true;
              invalidate.messages(projectId);
            } catch (err) {
              toast.error("Message failed", { description: err instanceof Error ? err.message : "Unknown error" });
            } finally {
              setSending(false);
            }
          }}
        >
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={1}
            placeholder="Message the counterparty"
            aria-label="Message the counterparty"
            className="max-h-[140px] flex-1 resize-none rounded-2xl border border-line bg-white/[0.03] px-4 py-3 text-sm leading-snug outline-none placeholder:text-faint focus:border-rose-accent/50"
          />
          <Button type="submit" disabled={!draft.trim() || sending} aria-label="Send" className={cn("h-10 w-10 shrink-0 rounded-full bg-rose-accent p-0 hover:bg-rose-bright", press)}>
            <PaperPlaneTilt className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="shrink-0 border-t border-line px-6 py-4 text-[12px] text-faint">Participants only.</div>
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
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ledgerDotColor(e.eventType) }} />
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
