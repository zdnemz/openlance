"use client";

/** /jobs/:id — detail + proposal flow. Awarding bridges into a project. */
import { use, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useJob, useProposals, useInvalidate, post } from "@/lib/queries";
import { del } from "@/lib/api";
import { uploadAttachment } from "@/lib/uploads";
import { useSession } from "@/lib/session";
import {
  AddressAvatar, Chip, EthAmount, Skeleton, EmptyState, ListHead, StatusBadge, AddressText,
} from "@/components/design";
import { AttachmentChip } from "@/components/attachment-chip";
import { AttachmentPicker } from "@/components/attachment-picker";
import { JobForm, CATEGORIES, CUSTOM_CATEGORY, type JobDraft } from "@/components/job-form";
import type { JobView } from "@/lib/types";
import { formatEth, timeAgo, toWei, ethToWei } from "@/lib/format";
import { useRuntime } from "@/lib/runtime";
import { sendContractCall, waitForReceipt, readRevertReason } from "@/lib/wallet";
import { describeFundingRevert, readJobBudget, returnBudgetSurplus } from "@/lib/chain-actions";
import { SurplusPanel } from "@/components/surplus-panel";
import { ESCROW_ABI } from "@/lib/contracts";
import { toast } from "sonner";
import { ArrowRight, Check, Lock, PaperPlaneTilt, Warning, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export default function JobDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = use(params);
  // ?stay=1 comes from the project room's wall ("Back to job posting") — it
  // breaks the redirect ping-pong: this visit stays on the job page.
  const stay = use(searchParams)?.stay === "1";
  const session = useSession();
  const { data: job, isLoading } = useJob(id);
  const isPoster = job?.poster?.id && session.user?.id === job.poster.id;
  const { data: proposals, isLoading: proposalsLoading } = useProposals(isPoster ? id : "");
  const invalidate = useInvalidate();
  const escrow = useRuntime((s) => s.escrow);
  const chainId = useRuntime((s) => s.chainId);
  const [awarding, setAwarding] = useState<string | null>(null);
  const router = useRouter();

  // Awarded jobs live in the project room now — everyone goes there, and the
  // room itself gates reads (participants/arbiters in, everyone else gets the
  // "not yours to see" wall). Unfunded-yet awards land there too: the fund
  // recovery button lives in the room, guarded against double-funding.
  // The proxy already 307s a cold visit to an awarded posting (see proxy.ts);
  // this covers the two it can't: a router-cached RSC payload, and the award
  // landing while this page is open.
  const projectId = job?.projectId ?? null;
  useEffect(() => {
    // fromJob lets the project room's "not yours to see" wall link back to
    // this posting instead of dead-ending strangers.
    if (projectId && !stay) router.replace(`/projects/${projectId}?fromJob=${id}`);
  }, [projectId, router, id, stay]);

  async function accept(proposalId: string) {
    // `disabled={awarding}` only shut THIS row's button. Clicking Accept on a
    // second bid before the first funding tx mined sent two concurrent
    // /accept POSTs — the exact double-write `chain-actions` guards against.
    if (awarding) return;
    setAwarding(proposalId);
    try {
      const result = await post<{
        project: { id: string };
        /** Ceiling − bid, unlocked back to the client right after funding. */
        surplusLockedWei: string;
        funding: { jobRef: string; freelancer: string; totalWei: string; items: { ref: string; amountWei: string }[] };
      }>(`/proposals/${proposalId}/accept`);
      invalidate.job(id);
      invalidate.proposals(id);
      invalidate.projects();

      // One signature funds EVERY milestone of the project up front, drawing
      // from the budget locked at publish. The client never signs again as
      // milestones start.
      let funded = true;
      if (escrow && result.funding?.items?.length) {
        const total = result.funding.items.reduce((a, m) => a + toWei(m.amountWei), 0n);
        const budget = await readJobBudget(escrow, result.funding.jobRef).catch(() => null);
        if (budget && total > budget.free) {
          // Already funded on-chain (e.g. award retried after the first batch
          // landed, or the mirror lagging behind it) — skip the second tx
          // instead of sending one that is guaranteed to revert. Falls through
          // to the success toast below: the milestones ARE funded.
        } else try {
          const hash = await sendContractCall({
            to: escrow,
            abi: ESCROW_ABI,
            functionName: "fundAllFromCredit",
            args: [
              result.funding.jobRef,
              result.funding.items.map((m) => m.ref),
              result.funding.items.map(() => result.funding.freelancer),
              result.funding.items.map((m) => toWei(m.amountWei)),
            ],
            expectedChainId: chainId,
          });
          const receipt = await waitForReceipt(hash);
          if (receipt.status !== "success") throw new Error("Funding transaction reverted on-chain");
        } catch (fundErr) {
          funded = false;
          const raw = fundErr instanceof Error ? fundErr.message : "Unknown error";
          toast.error("Project created, but funding did not land", {
            description: `${describeFundingRevert(raw, total, budget?.free ?? null)} Open the project room to fund the milestones.`,
            action: { label: "Open project", onClick: () => router.push(`/projects/${result.project.id}`) },
          });
        }
      }

      if (funded) {
        // The ceiling went in at publish; the bid is now reserved for the
        // milestones. Whatever the bid didn't use belongs to the client, so it
        // goes straight back — one extra signature, right where the award
        // already has their wallet open. A reject just leaves it locked.
        const jobRef = result.funding?.jobRef;
        const returnedWei = escrow && jobRef ? await returnBudgetSurplus(escrow, jobRef, chainId) : 0n;
        const tail = returnedWei > 0n
          ? ` Surplus ${formatEth(returnedWei.toString())} ETH is back in your wallet.`
          : toWei(result.surplusLockedWei) > 0n
            ? ` Surplus ${formatEth(result.surplusLockedWei)} ETH is still locked on the job.`
            : "";
        toast.success("Proposal accepted — milestones funded", {
          description: `Every milestone is locked from the job budget; work needs no further signatures.${tail}`,
          action: { label: "Open project", onClick: () => router.push(`/projects/${result.project.id}`) },
        });
      }
    } catch (err) {
      toast.error("Could not award", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setAwarding(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!job) {
    return <EmptyState title="Job not found" body="It may have been cancelled, or the link is stale." />;
  }
  if (job.projectId && !stay) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* header */}
      <div>
        <div className="flex items-center gap-3">
          <span className="num bg-white/[0.05] px-2 py-0.5 text-[11px] uppercase tracking-wider text-dim">{job.category}</span>
          <StatusBadge status={job.status} pulse={job.status === "open"} />
          <span className="num text-[11px] text-faint">posted {timeAgo(job.createdAt)}</span>
        </div>
        <h1 className="display mt-4 max-w-[34ch] text-[30px] leading-[1.08] md:text-[36px]">{job.title}</h1>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          {job.poster && (
            <Link href={`/profile/${job.poster.walletAddress}`} className="flex items-center gap-2.5 text-sm text-dim hover:text-foreground">
              <AddressAvatar address={job.poster.walletAddress} size={30} />
              {job.poster.displayName ?? <AddressText value={job.poster.walletAddress} />}
              <span className="num text-[11px] text-faint">
                · {job.poster.stats.completedProjectsAsClient} completed as client
              </span>
            </Link>
          )}
          <span className="num text-sm">
            up to <span className="text-foreground">{formatEth(job.budget.maxWei)} ETH</span>
          </span>
        </div>
      </div>

      {job.projectId && stay && (
        <div className="glass flex flex-wrap items-center gap-3 px-5 py-4 text-[13px] text-dim">
          <span>This job was awarded — work continues in the project room.</span>
          <Link href={`/projects/${job.projectId}`} className="ml-auto bg-white/10 px-4 py-2 text-[12.5px] font-medium hover:bg-white/20">
            Open project room
          </Link>
        </div>
      )}

      {isPoster && !job.projectId && job.status !== "in_progress" && (
        <div className="flex justify-end">
          <DeleteJob jobId={id} jobRef={job.jobRef} />
        </div>
      )}

      <div className="grid gap-10 lg:grid-cols-[1.55fr_1fr]">
        {/* left: the brief */}
        <div className="min-w-0 space-y-10">
          {isPoster && job.status === "draft" && (
            <section>
              <ListHead>Edit draft</ListHead>
              <p className="mt-2.5 max-w-[58ch] text-[13px] text-faint">
                Everything is editable while it's a draft.
              </p>
              <div className="mt-5">
                <JobForm jobId={id} initial={jobToDraft(job)} />
              </div>
            </section>
          )}

          <section>
            <ListHead>The brief</ListHead>
            <div className="mt-4 max-w-[60ch] space-y-4 text-[14.5px] leading-relaxed text-dim">
              {job.description.split("\n\n").map((para, i) => (
                <p key={i} className="whitespace-pre-wrap">{para}</p>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {job.skills.map((s) => (
                <Chip key={s}>{s}</Chip>
              ))}
            </div>
          </section>
        </div>

        {/* right: deposit gate (draft) / surplus + proposals / propose */}
        <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          {isPoster && job.status === "draft" && (
            <DepositPanel jobId={id} jobRef={job.jobRef} budgetWei={job.budget.maxWei} />
          )}
          {/* Every status, draft included: withdrawing a published job's budget
              sends it back to draft, and a partial withdrawal leaves the rest
              locked with no other way to reach it. The panel self-hides at zero. */}
          {isPoster && <SurplusPanel jobId={id} jobRef={job.jobRef} />}
          {isPoster ? (
            <section>
              {/* Gated on the query: `proposals?.length ?? 0` printed "0" and
                  flashed "No proposals yet" while the list was still loading. */}
              <ListHead>Proposals{!proposalsLoading ? ` · ${proposals?.length ?? 0}` : ""}</ListHead>
              {!proposals && proposalsLoading ? (
                <div className="mt-4 space-y-3">
                  <Skeleton className="h-24" />
                  <Skeleton className="h-24" />
                </div>
              ) : !proposals?.length ? (
                <EmptyState
                  className="mt-4"
                  title="No proposals yet"
                  body={
                    job.status === "draft"
                      ? "Publish first — freelancers can propose once the deposit locks."
                      : "Freelancers see this job the moment it's open. Switch to the freelancer seat to propose."
                  }
                />
              ) : (
                <div className="mt-4 space-y-4">
                  {proposals.map((p) => (
                    <ProposalCard key={p.id} proposal={p} onAccept={() => accept(p.id)} awarding={awarding !== null} />
                  ))}
                </div>
              )}
            </section>
          ) : job.status === "open" && session.token && session.user?.role === "freelancer" ? (
            <ProposeForm jobId={id} />
          ) : job.status === "open" && session.token ? (
            <div className="glass p-6 text-sm text-dim">
              <span className="flex items-center gap-2.5">
                <Lock className="h-4 w-4 text-faint" /> Proposing needs the freelancer seat — your account is locked to the {session.user?.role} seat.
              </span>
            </div>
          ) : (
            <div className="glass p-6 text-sm text-dim">
              {job.status !== "open" ? (
                <span className="flex items-center gap-2.5">
                  <Lock className="h-4 w-4 text-faint" /> This job is {job.status.replace("_", " ")} — proposals are closed.
                </span>
              ) : (
                <span className="flex items-center gap-2.5">
                  <Lock className="h-4 w-4 text-faint" /> Connect a wallet and sign in to propose on this job.
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── map a saved draft back into the form ──────────────────────────────── */

function jobToDraft(job: JobView): JobDraft {
  const known = CATEGORIES.includes(job.category);
  return {
    title: job.title,
    description: job.description,
    category: known ? job.category : CUSTOM_CATEGORY,
    customCategory: known ? "" : job.category,
    skills: job.skills.join(", "),
    budget: job.budget.maxEth,
  };
}

/* ── delete (poster view, any un-awarded job) ────────────────────────────────
   A published job's escrow key is derived from its id, so deleting the row
   while ETH is locked under it would strand that ETH forever. The server
   refuses in that case; here we withdraw first, then delete. That is attempted
   unconditionally — `returnBudgetSurplus` reads the free balance and returns 0
   without sending anything when there is nothing to take, and a draft can still
   be holding a lock (a withdrawal unpublishes the job, and it may be partial). */

function DeleteJob({ jobId, jobRef }: { jobId: string; jobRef: string }) {
  const escrow = useRuntime((s) => s.escrow);
  const chainId = useRuntime((s) => s.chainId);
  const invalidate = useInvalidate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      // The server re-checks on-chain, so this is convenience, not the gate.
      const back = escrow ? await returnBudgetSurplus(escrow, jobRef, chainId) : 0n;
      await del(`/jobs/${jobId}`);
      invalidate.job(jobId);
      toast.success("Job deleted", {
        description: back > 0n ? "The locked budget is back in your wallet." : "The job is gone.",
      });
      router.push("/jobs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the job");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-[12.5px] text-faint hover:text-destructive"
      >
        Delete job
      </Button>
    );
  }

  return (
    <div className="glass flex flex-wrap items-center gap-3 border-destructive/30 px-5 py-4 text-[13px]">
      <span className="text-dim">
        Any budget still locked in escrow goes back to your wallet before the job is deleted.
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy} className="px-4 py-2 text-[12.5px]">
          Keep it
        </Button>
        <Button
          onClick={remove}
          disabled={busy}
          className="bg-destructive px-4 py-2 text-[12.5px] font-medium text-white hover:bg-destructive/90"
        >
          {busy ? "Working…" : "Delete"}
        </Button>
      </div>
      {error && <p className="w-full text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

/* ── deposit gate (poster view, draft only) ─────────────────────────────── */

function DepositPanel({ jobId, jobRef, budgetWei }: { jobId: string; jobRef: string; budgetWei: string }) {
  const escrow = useRuntime((s) => s.escrow);
  const chainId = useRuntime((s) => s.chainId);
  const invalidate = useInvalidate();
  const [phase, setPhase] = useState<"idle" | "depositing" | "publishing">("idle");

  async function depositAndPublish() {
    setPhase("depositing");
    try {
      let depositTxHash: string;
      if (escrow) {
        // Drawdown model: lock the full ceiling in the escrow contract once;
        // every milestone of this job is then funded from that locked balance.
        // Whatever the winning bid doesn't use stays withdrawable.
        const hash = await sendContractCall({
          to: escrow,
          abi: ESCROW_ABI,
          functionName: "lockBudget",
          args: [jobRef],
          value: toWei(budgetWei),
          expectedChainId: chainId,
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== "success") {
          // The bare "reverted on-chain" hid the one reason that matters here:
          // a re-publish after a withdrawal is legal only once the old lock is
          // fully spent, and a partial withdrawal means the rest is still
          // escrowed and has to come back first.
          const reason = await readRevertReason(escrow, hash);
          throw new Error(describeFundingRevert(reason ?? "Deposit transaction reverted on-chain", toWei(budgetWei), null));
        }
        depositTxHash = hash;
      } else {
        // Dev mode (no escrow configured): the server accepts the hash shape
        // alone; real mode verifies the lock on-chain before publishing.
        // `crypto.randomUUID` is undefined in a non-secure context (a LAN dev
        // origin) and in Safari < 15.4 — "Dev mode" became a TypeError toast.
        const rand = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, "");
        depositTxHash = `0x${rand()}${rand().slice(0, 32)}`;
      }
      setPhase("publishing");
      await post(`/jobs/${jobId}/publish`, { depositTxHash });
      invalidate.job(jobId);
      toast.success("Job published", { description: "Budget locked in escrow — it's live in the marketplace." });
    } catch (err) {
      toast.error("Could not publish", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setPhase("idle");
    }
  }

  return (
    <section className="glass-raised p-6">
      <ListHead>Publish — lock the budget first</ListHead>
      <p className="mt-2.5 text-[13px] leading-relaxed text-dim">
        This draft is private. Publishing locks <EthAmount wei={budgetWei} className="text-foreground" /> (your max
        budget) in the escrow contract, so every live job is funded and freelancers know the money is there. The winning
        bid is drawn from it; the rest is withdrawable.
      </p>
      {escrow ? (
        <p className="num mt-3 break-all text-[11px] text-faint">escrow {escrow}</p>
      ) : (
        <p className="mt-3 text-[11px] text-faint">Dev mode: no escrow configured, publishing records a simulated deposit.</p>
      )}
      <Button
        disabled={phase !== "idle"}
        onClick={depositAndPublish}
        className="mt-4 w-full bg-amber-500 py-3 text-[13px] font-medium text-ink hover:bg-amber-400"
      >
        {phase === "idle" ? `Lock ${formatEth(budgetWei)} ETH + publish` : phase === "depositing" ? "Waiting for lock…" : "Publishing…"}
      </Button>
    </section>
  );
}

/* ── surplus withdrawal (poster view, published jobs) ─────────────────── */


/* ── a bid's file ────────────────────────────────────────────────────────
   The API signs a short-lived URL on GET, so opening one is one round-trip and
   the bytes never touch a public path. */

const EMPTY_MILESTONE = { title: "", description: "", amount: "" };
/** Mirrors the API's `z.array(...).max(20)` on a proposal's milestones. */
const MAX_PROPOSAL_MILESTONES = 20;

/* ── proposal card (poster view) ──────────────────────────────────────── */

function ProposalCard({ proposal, onAccept, awarding }: { proposal: import("@/lib/types").ProposalView; onAccept: () => void; awarding: boolean }) {
  return (
    <article className="glass p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="num text-[11px] uppercase tracking-wider text-faint">{proposal.deliveryDays} days</div>
          <div className="mt-1 flex items-center gap-2 text-[15px] font-medium">
            <EthAmount wei={proposal.bidTotalWei} className="text-rose-bright" />
            <span className="text-xs text-faint">bid total</span>
          </div>
        </div>
        <StatusBadge status={proposal.status} pulse={false} />
      </div>
      <p className="mt-4 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{proposal.coverNote}</p>
      <div className="mt-4 space-y-1.5">
        {proposal.milestones.map((m) => (
          <div key={m.position} className="flex items-center justify-between border border-line bg-white/[0.02] px-3.5 py-2 text-[12.5px]">
            <span className="truncate text-dim">{m.title}</span>
            <EthAmount wei={m.amountWei} className="shrink-0 text-xs" />
          </div>
        ))}
      </div>
      {proposal.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {proposal.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {proposal.status === "submitted" && (
        <Button onClick={onAccept} disabled={awarding} className="mt-5 w-full bg-rose-accent hover:bg-rose-bright">
          {awarding ? "Awarding…" : `Accept ${formatEth(proposal.bidTotalWei)} ETH bid`}
        </Button>
      )}
    </article>
  );
}

/* ── propose form (freelancer view) ───────────────────────────────────── */

function ProposeForm({ jobId }: { jobId: string }) {
  const session = useSession();
  const { data: job } = useJob(jobId);
  const { data: myProposals } = useProposals(jobId);
  // The server's ceiling, not a local copy — the API refuses past it.
  const { storage } = useRuntime();
  const maxAttachments = storage?.maxAttachments ?? 3;
  // Mirrors the API's partial unique index: only a LIVE proposal (submitted or
  // accepted) occupies the freelancer's one slot. Withdrawn and rejected are
  // history, so they must not hide the form — filtering them out is what used to
  // offer a fresh bid on a job where the resubmit was guaranteed to 409.
  const mine = myProposals?.find(
    (p) => p.freelancerId === session.user?.id && (p.status === "submitted" || p.status === "accepted"),
  );
  const myWithdrawn = myProposals?.find(
    (p) => p.freelancerId === session.user?.id && p.status === "withdrawn",
  );
  const invalidate = useInvalidate();

  const [coverNote, setCoverNote] = useState("");
  const [deliveryDays, setDeliveryDays] = useState("14");
  const [milestones, setMilestones] = useState<{ title: string; description: string; amount: string }[]>([EMPTY_MILESTONE]);
  const [files, setFiles] = useState<File[]>([]);
  // `open` was SEEDED from `mine`, which is still `undefined` on the first
  // render (the proposals query hasn't resolved) — so it latched `true` and
  // never re-synced. A freelancer revisiting a job they bid on got the blank
  // form, whose own hint says "one proposal per freelancer", and submitting it
  // 409'd. Derive it from the query instead of seeding from it.
  const [dismissedMine, setDismissedMine] = useState(false);
  // `open` is the "I want to replace my live bid" escape hatch, toggled from the
  // summary card. A WITHDRAWN bid does not close the form: its slot is free, so
  // the form is the primary surface and the summary sits above it.
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showForm = !mine || open || dismissedMine;

  // The server charges `Σ parseEther(amount)` exactly; a `Number` sum rounded the
  // freelancer's own approval surface away from that amount in both directions
  // (0.0004 showed "0.000 ETH", 0.0015 showed "0.002 ETH"). `ethToWei`, not the
  // `toWei` wei parser — that read "5" as 5 wei and showed 5 ETH as 5e-18.
  const totalWei = milestones.reduce((acc, m) => acc + ethToWei(m.amount), 0n);
  const ceilingWei = toWei(job?.budget.maxWei);
  const overCeiling = ceilingWei > 0n && totalWei > ceilingWei;

  async function submit() {
    setError(null);
    if (coverNote.trim().length < 20) return setError("The cover note needs at least 20 characters — say what you'd actually do first.");
    const days = Number(deliveryDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return setError("Delivery days must be a whole number between 1 and 365.");
    if (!milestones.length) return setError("At least one milestone is required — this is milestone escrow, after all.");
    if (!milestones.every((m) => m.title.trim() && m.description.trim() && /^\d*\.?\d+$/.test(m.amount))) {
      return setError("Every milestone needs a title, a description, and a valid ETH amount.");
    }
    if (overCeiling) return setError(`Your bid (${formatEth(totalWei)} ETH) is over the client's ceiling of ${formatEth(ceilingWei)} ETH.`);
    setSubmitting(true);
    try {
      // Files hang off the proposal, so the proposal row has to exist first.
      // A failed upload leaves a valid bid without the file — reported, not hidden.
      const created = await post<{ id: string }>(`/jobs/${jobId}/proposals`, {
        coverNote: coverNote.trim(),
        deliveryDays: days,
        milestones: milestones.map((m) => ({ title: m.title.trim(), description: m.description.trim(), amount: m.amount })),
      });
      if (files.length) {
        setUploading(true);
        for (const f of files) {
          await uploadAttachment(`/proposals/${created.id}`, f);
        }
      }
      invalidate.proposals(jobId);
      setDismissedMine(true);
      setOpen(false);
      toast.success("Proposal submitted", { description: "The poster sees it instantly. Awarding creates the project." });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
      setUploading(false);
    }
  }

  if (mine && !showForm) {
    return (
      <section>
        <ListHead>Your proposal</ListHead>
        <div className="glass mt-4 p-6">
          <div className="flex items-center justify-between">
            <EthAmount wei={mine.bidTotalWei} className="text-lg font-medium text-rose-bright" />
            <StatusBadge status={mine.status} pulse={false} />
          </div>
          <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{mine.coverNote}</p>
          {mine.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {mine.attachments.map((a) => <AttachmentChip key={a.id} attachment={a} />)}
            </div>
          )}
        </div>
      </section>
    );
  }

  // A withdrawn bid is history, not a live claim. Showing the form on its own
  // was the trap: it looked like a fresh start while the slot was still taken.
  // Say what happened, and that the slot is open again.
  if (myWithdrawn && !mine) {
    return (
      <section className="space-y-4">
        <div className="border border-line bg-white/[0.012] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <ListHead>Your withdrawn proposal</ListHead>
              <p className="mt-1.5 max-w-[58ch] text-[12.5px] leading-relaxed text-faint">
                You pulled this bid, so it is no longer with the client. Your slot on this job is open again — you can
                submit a new proposal while the job is still open.
              </p>
            </div>
            <EthAmount wei={myWithdrawn.bidTotalWei} className="text-lg font-medium text-faint line-through" />
          </div>
          {myWithdrawn.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {myWithdrawn.attachments.map((a) => <AttachmentChip key={a.id} attachment={a} />)}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={() => setDismissedMine(false)}
          className="w-full border border-line py-2.5 text-[12.5px] text-dim hover:text-foreground"
        >
          Submit a new proposal
        </Button>
      </section>
    );
  }

  if (!showForm) return null;

  return (
    <section>
      <ListHead>Propose</ListHead>
      <div className="glass mt-4 space-y-5 p-6">
        <div className="space-y-2">
          <label htmlFor="proposal-cover" className="text-[13px] font-medium">Cover note</label>
          <Textarea
            id="proposal-cover"
            value={coverNote}
            onChange={(e) => setCoverNote(e.target.value)}
            rows={5}
            placeholder="How you'd approach it, what you've shipped before, and why the milestones should look the way you've shaped them."
          />
          <p className="text-[11px] text-faint">Minimum 20 characters. One proposal per freelancer per job — make it count.</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="proposal-days" className="text-[13px] font-medium">Delivery window</label>
          <div className="flex items-center gap-3">
            <Input
              id="proposal-days"
              type="number" min={1} max={365} value={deliveryDays}
              onChange={(e) => setDeliveryDays(e.target.value)}
              className="num h-10 w-28 border-line bg-white/[0.03]"
            />
            <span className="text-[13px] text-faint">days from award to final milestone</span>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[13px] font-medium">Your milestone breakdown</span>
              <p className="mt-1 text-[11px] text-faint">You shape the work. The client reviews this and pays the total if they accept. Up to {MAX_PROPOSAL_MILESTONES}.</p>
            </div>
            <button
              type="button"
              // The server caps at 20 (`z.array(...).max(20)`); uncapped, the 21st
              // row submitted fine and came back as a raw schema error.
              disabled={milestones.length >= MAX_PROPOSAL_MILESTONES}
              onClick={() => setMilestones([...milestones, { ...EMPTY_MILESTONE }])}
              className="shrink-0 text-[12px] text-rose-bright hover:underline disabled:cursor-not-allowed disabled:text-faint disabled:no-underline"
            >
              + add milestone
            </button>
          </div>
          {milestones.map((m, i) => (
            <div key={i} className="space-y-2 border border-line bg-white/[0.02] p-4">
              <div className="flex gap-3">
                <Input
                  aria-label={`Milestone ${i + 1} title`}
                  value={m.title} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  placeholder={`Milestone ${i + 1} title`} className="h-9 border-line bg-white/[0.03] text-[13px]"
                />
                <Input
                  aria-label={`Milestone ${i + 1} amount in ETH`} inputMode="decimal"
                  value={m.amount} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  placeholder="0.00" className="num h-9 w-28 shrink-0 border-line bg-white/[0.03] text-[13px]"
                />
                {milestones.length > 1 && (
                  <button
                    type="button" aria-label={`Remove milestone ${i + 1}`}
                    onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}
                    className="grid size-9 shrink-0 place-items-center text-faint hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Textarea
                aria-label={`Milestone ${i + 1} deliverable`}
                value={m.description} rows={2}
                onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                placeholder="What gets delivered, and what the reviewer checks"
                className="text-[13px]"
              />
            </div>
          ))}
          <div className={`flex items-center justify-between px-4 py-3 ${overCeiling ? "bg-destructive/10" : "bg-white/[0.04]"}`}>
            <span className="num text-[11px] uppercase tracking-wider text-faint">
              your bid{ceilingWei > 0n ? ` · ceiling ${formatEth(ceilingWei)} ETH` : ""}
            </span>
            <span className={`num text-lg font-medium ${overCeiling ? "text-destructive" : "text-rose-bright"}`}>
              {formatEth(totalWei)} ETH
            </span>
          </div>
        </div>

        <AttachmentPicker
          files={files}
          onChange={setFiles}
          max={maxAttachments}
          label="Supporting files"
          emptyLabel="Attach a portfolio piece, past audit, or spec"
          hint="The poster can read these while reviewing your bid. They move to the project if you win."
        />

        {error && (
          <p role="alert" className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">
            <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        <Button onClick={submit} disabled={submitting || uploading} className="w-full bg-rose-accent hover:bg-rose-bright">
          {submitting
            ? uploading ? "Uploading files…" : "Submitting…"
            : <span className="flex items-center gap-2"><PaperPlaneTilt className="h-4 w-4" /> Submit proposal</span>}
        </Button>
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Check className="h-3 w-3 text-state-released" />
          {job ? `Client's ceiling ${formatEth(job.budget.maxWei)} ETH — your bid can be any amount at or under it` : ""}
        </p>
      </div>
    </section>
  );
}
