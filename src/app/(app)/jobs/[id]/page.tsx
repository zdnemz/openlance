"use client";

/** /jobs/:id — detail + proposal flow. Awarding bridges into a project. */
import { use, useState } from "react";
import Link from "next/link";
import { useJob, useProposals, useInvalidate, post } from "@/lib/queries";
import { useSession } from "@/lib/session";
import {
  AddressAvatar, Chip, EthAmount, Skeleton, EmptyState, press, SectionLabel, StatusBadge, AddressText,
} from "@/components/design";
import { formatEth, timeAgo } from "@/lib/format";
import { toast } from "sonner";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Lock } from "@phosphor-icons/react/dist/csr/Lock";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const { data: job, isLoading } = useJob(id);
  const isPoster = job?.poster?.id && session.user?.id === job.poster.id;
  const { data: proposals } = useProposals(isPoster ? id : "");
  const invalidate = useInvalidate();
  const [awarding, setAwarding] = useState<string | null>(null);

  async function accept(proposalId: string) {
    setAwarding(proposalId);
    try {
      const result = await post<{ project: { id: string } }>(`/proposals/${proposalId}/accept`);
      invalidate.job(id);
      invalidate.proposals(id);
      invalidate.projects();
      toast.success("Proposal accepted — project created", {
        description: "Milestones spawned from the winning breakdown. Fund the first one from the project room.",
        action: { label: "Open project", onClick: () => (window.location.href = `/projects/${result.project.id}`) },
      });
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
        <Skeleton className="h-40 w-full rounded-3xl" />
        <Skeleton className="h-64 w-full rounded-3xl" />
      </div>
    );
  }
  if (!job) {
    return <EmptyState title="Job not found" body="It may have been cancelled, or the link is stale." />;
  }

  return (
    <div className="space-y-10">
      {/* header */}
      <div>
        <div className="flex items-center gap-3">
          <span className="num rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-wider text-dim">{job.category}</span>
          <StatusBadge status={job.status} pulse={job.status === "open"} />
          <span className="num text-[11px] text-faint">posted {timeAgo(job.createdAt)}</span>
        </div>
        <h1 className="mt-4 max-w-[34ch] text-3xl font-semibold leading-tight tracking-tighter md:text-4xl">{job.title}</h1>
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
            budget <span className="text-foreground">{formatEth(job.budget.minWei)}–{formatEth(job.budget.maxWei)} ETH</span>
          </span>
        </div>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1.55fr_1fr]">
        {/* left: description + template */}
        <div className="min-w-0 space-y-10">
          <section>
            <SectionLabel>the brief</SectionLabel>
            <div className="mt-4 space-y-4 text-[14.5px] leading-relaxed text-dim">
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

          <section>
            <SectionLabel>milestone template</SectionLabel>
            <p className="mt-2.5 text-[13px] text-faint">
              The poster's proposed breakdown — your bid can reshape it, but every milestone must be funded before its
              work starts.
            </p>
            <ol className="mt-5 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
              {job.milestones.map((m) => (
                <li key={m.id} className="flex items-start gap-5 bg-white/[0.012] px-6 py-5">
                  <span className="num mt-0.5 text-[11px] text-faint">{String(m.position).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-medium">{m.title}</div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-faint">{m.description}</p>
                  </div>
                  <EthAmount wei={m.amountWei} className="mt-0.5 shrink-0 text-sm text-foreground" />
                </li>
              ))}
              <li className="flex items-center justify-between bg-white/[0.03] px-6 py-4">
                <span className="num text-[11px] uppercase tracking-wider text-faint">template total</span>
                <EthAmount wei={job.templateTotalWei} className="text-base font-medium text-rose-bright" />
              </li>
            </ol>
          </section>
        </div>

        {/* right: proposals / propose */}
        <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          {isPoster ? (
            <section>
              <SectionLabel>proposals ({proposals?.length ?? 0})</SectionLabel>
              {!proposals?.length ? (
                <EmptyState className="mt-4" title="No proposals yet" body="Freelancers see this job the moment it's open. The seeded personas are active on the devnet." />
              ) : (
                <div className="mt-4 space-y-4">
                  {proposals.map((p) => (
                    <ProposalCard key={p.id} proposal={p} onAccept={() => accept(p.id)} awarding={awarding === p.id} />
                  ))}
                </div>
              )}
            </section>
          ) : job.status === "open" && session.token ? (
            <ProposeForm jobId={id} />
          ) : (
            <div className="glass rounded-3xl p-6 text-sm text-dim">
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

/* ── proposal card (poster view) ──────────────────────────────────────── */

function ProposalCard({ proposal, onAccept, awarding }: { proposal: import("@/lib/types").ProposalView; onAccept: () => void; awarding: boolean }) {
  return (
    <article className="glass rounded-3xl p-6">
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
      <p className="mt-4 text-[13.5px] leading-relaxed text-dim">{proposal.coverNote}</p>
      <div className="mt-4 space-y-1.5">
        {proposal.milestones.map((m) => (
          <div key={m.position} className="flex items-center justify-between rounded-xl border border-line bg-white/[0.02] px-3.5 py-2 text-[12.5px]">
            <span className="truncate text-dim">{m.title}</span>
            <EthAmount wei={m.amountWei} className="shrink-0 text-xs" />
          </div>
        ))}
      </div>
      {proposal.status === "submitted" && (
        <Button onClick={onAccept} disabled={awarding} className="mt-5 w-full rounded-full bg-rose-accent hover:bg-rose-bright">
          {awarding ? "Awarding…" : "Accept + create project"}
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
  const mine = myProposals?.find((p) => p.freelancerId === session.user?.id && p.status !== "withdrawn");
  const invalidate = useInvalidate();

  const [coverNote, setCoverNote] = useState("");
  const [deliveryDays, setDeliveryDays] = useState("14");
  const [milestones, setMilestones] = useState<{ title: string; description: string; amount: string }[]>([]);
  const [open, setOpen] = useState(!mine);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // seed the editor with the job template once
  if (job && milestones.length === 0 && !mine) {
    setMilestones(job.milestones.map((m) => ({ title: m.title, description: m.description, amount: m.amountEth })));
  }

  const total = milestones.reduce((acc, m) => acc + (Number(m.amount) || 0), 0);

  async function submit() {
    setError(null);
    if (coverNote.trim().length < 20) return setError("The cover note needs at least 20 characters — say what you'd actually do first.");
    const days = Number(deliveryDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return setError("Delivery days must be a whole number between 1 and 365.");
    if (!milestones.length) return setError("At least one milestone is required — this is milestone escrow, after all.");
    if (!milestones.every((m) => m.title.trim() && m.description.trim() && /^\d*\.?\d+$/.test(m.amount))) {
      return setError("Every milestone needs a title, a description, and a valid ETH amount.");
    }
    setSubmitting(true);
    try {
      await post(`/jobs/${jobId}/proposals`, {
        coverNote: coverNote.trim(),
        deliveryDays: days,
        milestones: milestones.map((m) => ({ title: m.title.trim(), description: m.description.trim(), amount: m.amount })),
      });
      invalidate.proposals(jobId);
      setOpen(false);
      toast.success("Proposal submitted", { description: "The poster sees it instantly. Awarding creates the project." });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  if (mine && !open) {
    return (
      <section>
        <SectionLabel>your proposal</SectionLabel>
        <div className="glass mt-4 rounded-3xl p-6">
          <div className="flex items-center justify-between">
            <EthAmount wei={mine.bidTotalWei} className="text-lg font-medium text-rose-bright" />
            <StatusBadge status={mine.status} pulse={false} />
          </div>
          <p className="mt-3 text-[13.5px] leading-relaxed text-dim">{mine.coverNote}</p>
        </div>
      </section>
    );
  }

  if (!open) return null;

  return (
    <section>
      <SectionLabel>propose</SectionLabel>
      <div className="glass mt-4 space-y-5 rounded-3xl p-6">
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Cover note</label>
          <Textarea
            value={coverNote}
            onChange={(e) => setCoverNote(e.target.value)}
            rows={5}
            placeholder="How you'd approach it, what you've shipped before, and why the milestones should look the way you've shaped them."
            className="resize-none border-line bg-white/[0.03] text-sm focus-visible:ring-rose-accent/40"
          />
          <p className="text-[11px] text-faint">Minimum 20 characters. One proposal per freelancer per job — make it count.</p>
        </div>

        <div className="space-y-2">
          <label className="text-[13px] font-medium">Delivery window</label>
          <div className="flex items-center gap-3">
            <Input
              type="number" min={1} max={365} value={deliveryDays}
              onChange={(e) => setDeliveryDays(e.target.value)}
              className="num h-10 w-28 border-line bg-white/[0.03]"
            />
            <span className="text-[13px] text-faint">days from award to final milestone</span>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-medium">Your milestone breakdown</label>
            <button
              type="button"
              onClick={() => setMilestones([...milestones, { title: "", description: "", amount: "" }])}
              className="text-[12px] text-rose-bright hover:underline"
            >
              + add milestone
            </button>
          </div>
          {milestones.map((m, i) => (
            <div key={i} className="space-y-2 rounded-2xl border border-line bg-white/[0.02] p-4">
              <div className="flex gap-3">
                <Input
                  value={m.title} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  placeholder={`Milestone ${i + 1} title`} className="h-9 border-line bg-white/[0.03] text-[13px]"
                />
                <Input
                  value={m.amount} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  placeholder="0.00" className="num h-9 w-28 shrink-0 border-line bg-white/[0.03] text-[13px]"
                />
                {milestones.length > 1 && (
                  <button
                    type="button" aria-label="Remove milestone"
                    onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}
                    className="shrink-0 text-faint hover:text-destructive"
                  >
                    <Stack className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Textarea
                value={m.description} rows={2}
                onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                placeholder="What gets delivered, and what the reviewer checks"
                className="resize-none border-line bg-white/[0.03] text-[13px]"
              />
            </div>
          ))}
          <div className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-4 py-3">
            <span className="num text-[11px] uppercase tracking-wider text-faint">your bid</span>
            <span className="num text-lg font-medium text-rose-bright">{total.toFixed(3)} ETH</span>
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">
            <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        <Button onClick={submit} disabled={submitting} className="w-full rounded-full bg-rose-accent hover:bg-rose-bright">
          {submitting ? "Submitting…" : <span className="flex items-center gap-2"><PaperPlaneTilt className="h-4 w-4" /> Submit proposal</span>}
        </Button>
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Check className="h-3 w-3 text-state-released" />
          {job ? `Within the posted budget ${formatEth(job.budget.minWei)}–${formatEth(job.budget.maxWei)} ETH` : ""}
        </p>
      </div>
    </section>
  );
}
