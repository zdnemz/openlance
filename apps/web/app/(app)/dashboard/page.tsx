"use client";

/**
 * /dashboard — the single adaptive home (every seat lands here).
 * The proxy guards every other page to its seat; this page renders the
 * active role's control room: client commissions, freelancer ships,
 * arbiter rules. One header grammar, one stat strip, one project list —
 * the sections below it change per seat.
 */
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProjects, useJobs, useDisputes, useProject, useJob, useLedger, useArbiters } from "@/lib/queries";
import { useSession, useSessionHydrated } from "@/lib/session";
import { EthAmount, Skeleton, EmptyState, ListHead, StatusBadge, AddressText, InlineLoading, press } from "@/components/design";
import { PageHeader } from "@/components/page-header";
import { ArbiterStakeSummary } from "@/components/arbiter-stake-panel";
import { SpotCard } from "@/components/motion";
import { STATE_COLORS, timeAgo, toWei, formatEth, ledgerDotColor } from "@/lib/format";
import type { DisputeView, JobView } from "@/lib/types";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Briefcase } from "@phosphor-icons/react/dist/csr/Briefcase";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { TrendUp } from "@phosphor-icons/react/dist/csr/TrendUp";
import { TrendDown } from "@phosphor-icons/react/dist/csr/TrendDown";

const HEAD: Record<string, { title: string; desc: string; cta: { href: string; label: string } }> = {
  client: {
    title: "Commission work.",
    desc: "Lock a funded brief in the marketplace, review bids, release on proof. Disputes go to staked arbiters — never custody.",
    cta: { href: "/jobs/new", label: "Post a job" },
  },
  freelancer: {
    title: "Ship work.",
    desc: "Propose on open jobs, deliver milestones, get paid by contract. Every release leaves a tx hash.",
    cta: { href: "/jobs", label: "Find work" },
  },
  arbiter: {
    title: "Rule on disputes.",
    desc: "Staked arbiters vote commit-reveal. Keep trust high and the stake stays eligible for selection.",
    cta: { href: "/stake", label: "Manage stake" },
  },
};

export default function DashboardPage() {
  const session = useSession();
  // The persisted session is null during SSR and the first client render, then
  // flips in. Without this gate the page painted the signed-out EmptyState on
  // the server, then swapped to the whole dashboard after hydration — and every
  // seat-conditional section (the client's drafts above all) was decided against
  // a session that did not exist yet. Same gate `profile/me` already uses.
  const sessionHydrated = useSessionHydrated();
  const router = useRouter();
  const { data: projects, isLoading } = useProjects();
  const { data: allJobs } = useJobs();
  // `GET /api/jobs` defaults to `status = 'open'` (the marketplace is open work
  // only), so the unfiltered list above can never contain a draft — a client's
  // unpublished postings were invisible on their own home. Drafts are
  // poster-scoped server-side, so this only ever returns the caller's own.
  const isClient = !!session.token && session.user?.role === "client";
  const { data: draftJobs } = useJobs({ status: "draft" }, isClient);
  const { data: disputes } = useDisputes();
  const { data: ledger } = useLedger({ limit: "8" });
  const { data: arbiters, isLoading: arbitersLoading } = useArbiters();

  // Belt over the proxy gate's suspenders: an unfinished onboarding bounces
  // instantly. Only while NOT yet onboarded, though — `proxy.ts` one-way
  // redirects /onboarding for an onboarded visitor, so sending one there
  // ping-ponged this effect against the proxy forever.
  useEffect(() => {
    if (session.token && session.user && session.user.kycStatus !== "verified" && !session.user.role) {
      router.replace("/onboarding");
    }
  }, [session.token, session.user, router]);

  // Hold a stable shape until the session has actually rehydrated. Rendering
  // the signed-out card first and then the whole dashboard is a visible swap,
  // and it made every seat-conditional section (drafts, stake, disputes) depend
  // on a session that did not exist yet.
  if (!sessionHydrated) {
    return (
      <div className="space-y-10" aria-busy="true">
        <Skeleton className="h-14 w-2/3" />
        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-line py-7 md:grid-cols-4">
          <Skeleton className="h-12 w-24" />
          <Skeleton className="h-12 w-24" />
          <Skeleton className="h-12 w-24" />
          <Skeleton className="h-12 w-24" />
        </div>
        <Skeleton className="h-48 rounded-3xl" />
      </div>
    );
  }

  if (!session.token || !session.user) {
    return (
      <EmptyState
        className="mt-16"
        title="Your dashboard lives behind your key"
        body="Connect a wallet and prove ownership — projects, escrow states, and earnings are scoped to your address. Then pick a role and verify identity in onboarding."
        action={<Link href="/jobs" className="text-sm text-rose-bright hover:underline">Browse jobs meanwhile</Link>}
      />
    );
  }

  const me = session.user;
  const role = me.role;
  const head = HEAD[role] ?? HEAD.client;
  const myJobs = (allJobs?.items ?? []).filter((j) => j.poster?.id === me.id);
  const openJobs = (allJobs?.items ?? []).filter((j) => j.status === "open");
  // Drafts live in their own query — see above. The API already orders by
  // `desc(createdAt)`, newest first.
  const drafts = draftJobs?.items ?? [];
  const active = (projects ?? []).filter((p) => p.status === "active");
  const done = (projects ?? []).filter((p) => p.status === "completed");
  const openDisputes = (disputes ?? []).filter((d) => d.status !== "resolved");
  const settledDisputes = (disputes ?? []).filter((d) => d.status === "resolved" || d.finalized);
  const eligibleArbiters = (arbiters ?? []).filter((a) => a.registered && a.eligible).length;

  const meta =
    role === "arbiter" ? (
      arbitersLoading
        ? <InlineLoading label="reading the registry…" />
        : <>{openDisputes.length} open · {eligibleArbiters} eligible<br />clocks run on-chain</>
    ) : (
      <>{active.length} in flight · {done.length} completed<br />money moves by contract</>
    );

  return (
    <div className="space-y-10">
      {me.kycStatus !== "verified" && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-line bg-white/[0.012] px-6 py-4">
          <p className="text-[13px] text-dim">
            {me.kycStatus === "pending" ? "KYC pending — approve it to unlock posting and proposing." : "Finish onboarding — pick your seat and verify identity to unlock posting and proposing."}
          </p>
          <Link href="/onboarding" className="rounded-full bg-rose-accent px-4 py-2 text-[12.5px] font-medium text-white hover:bg-rose-bright">
            {me.kycStatus === "pending" ? "Review KYC" : "Finish onboarding"}
          </Link>
        </div>
      )}

      <PageHeader
        title={head.title}
        desc={me.displayName ? `${greet(me.displayName, role)} ${head.desc}` : head.desc}
        meta={meta}
        actions={
          <Link href={head.cta.href} className={`inline-flex items-center gap-1.5 rounded-full bg-rose-accent px-5 py-2.5 text-[13px] font-medium text-white hover:bg-rose-bright ${press}`}>
            {head.cta.label} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
      />

      {role === "arbiter" ? (
        <ArbiterStats open={openDisputes.length} settled={settledDisputes.length} serving={active.length} />
      ) : role === "freelancer" ? (
        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-line py-7 md:grid-cols-4">
          <Stat label="earned on-chain" value={<EthAmount wei={me.stats.totalEarnedWei} className="text-rose-bright" />} icon={<TrendUp className="h-4 w-4 text-rose-bright" />} />
          <Stat label="projects in flight" value={<span className="num">{active.length}</span>} sub={`${done.length} completed`} />
          <Stat label="open disputes" value={<span className="num">{openDisputes.length}</span>} icon={openDisputes.length ? <Gavel className="h-4 w-4 text-state-disputed" /> : undefined} />
          <Stat label="open jobs" value={<span className="num">{openJobs.length}</span>} sub="to propose on" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-line py-7 md:grid-cols-4">
          <Stat label="paid through escrow" value={<EthAmount wei={me.stats.totalPaidWei} className="text-rose-bright" />} icon={<TrendDown className="h-4 w-4 text-rose-bright" />} />
          <Stat label="projects in flight" value={<span className="num">{active.length}</span>} sub={`${done.length} completed`} />
          <Stat label="your open jobs" value={<span className="num">{myJobs.length}</span>} sub={`${openJobs.length} open market-wide`} />
          <Stat label="open disputes" value={<span className="num">{openDisputes.length}</span>} icon={openDisputes.length ? <Gavel className="h-4 w-4 text-state-disputed" /> : undefined} />
        </div>
      )}

      {role === "arbiter" && <ArbiterStakeSummary />}

      {/* Unpublished drafts. A draft is the client's next action — it needs a
          budget lock to go live — so it leads, above everything else. */}
      {role === "client" && drafts.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between">
            <ListHead>Drafts</ListHead>
            <span className="num text-[11px] text-faint">
              {drafts.length} unpublished · lock the budget to publish
            </span>
          </div>
          <div className="mt-5 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-amber-400/25 bg-amber-400/[0.04]">
            {drafts.map((j) => (
              <Link
                key={j.id}
                href={`/jobs/${j.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 transition-colors hover:bg-white/[0.035]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{j.title}</span>
                  <span className="num mt-0.5 block text-[11px] text-faint">saved {timeAgo(j.createdAt)}</span>
                </span>
                <span className="num shrink-0 text-[12px] text-amber-300">
                  {formatEth(j.budget.maxWei)} ETH to publish →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* active projects */}
      <section>
        <div className="flex items-baseline justify-between">
          <ListHead>{role === "arbiter" ? "Projects under dispute" : "Active projects"}</ListHead>
          {/* Counts the list it renders, not every project: a finished project
              is history, and "N total" over an active-only list read as a lie. */}
          <span className="num text-[11px] text-faint">
            {active.length}{done.length > 0 ? ` · ${done.length} completed` : ""}
          </span>
        </div>
        {isLoading ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Skeleton className="h-48 rounded-3xl" />
            <Skeleton className="h-48 rounded-3xl" />
          </div>
        ) : !active.length ? (
          // A user whose only projects are finished is not the same as a user
          // with none — say which, instead of nudging them to post more work.
          <EmptyState
            className="mt-5"
            icon={<Briefcase className="h-5 w-5" />}
            title={
              done.length > 0
                ? `${done.length} project${done.length === 1 ? "" : "s"} completed`
                : role === "client" ? "No projects yet" : role === "freelancer" ? "No work in flight" : "Nothing serving"
            }
            body={
              done.length > 0
                ? "Finished work moves off this list. Open a project room from your profile to settle up, leave a review, or check the payout."
                : role === "client"
                  ? "Post a job and award a proposal — the project room is where escrow happens."
                  : role === "freelancer"
                    ? "Propose on open work — awarded proposals become project rooms with funded milestones."
                    : "When a dispute selects you, its project appears here. Keep your stake eligible meanwhile."
            }
            action={
              done.length > 0
                ? <Link href="/profile/me" className="text-sm text-rose-bright hover:underline">See completed projects</Link>
                : <Link href={role === "freelancer" ? "/jobs" : role === "client" ? "/jobs/new" : "/disputes"} className="text-sm text-rose-bright hover:underline">{role === "arbiter" ? "Open the dispute queue" : role === "client" ? "Post your first job" : "Explore open jobs"}</Link>
            }
          />
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {active.map((p) => <ProjectCard key={p.id} id={p.id} jobId={p.jobId} />)}
          </div>
        )}
      </section>

      <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
        {role === "client" ? (
          <section>
            <ListHead>Your open jobs</ListHead>
            {!myJobs.length ? (
              <p className="mt-4 max-w-[60ch] text-sm text-faint">Nothing posted. <Link href="/jobs/new" className="text-rose-bright hover:underline">Post one</Link> with a brief and your max budget.</p>
            ) : (
              <JobRows jobs={myJobs} />
            )}
            <Link href="/jobs" className={`mt-3 inline-flex items-center gap-1.5 text-[12px] text-faint hover:text-dim ${press}`}>
              browse the marketplace <ArrowRight className="h-3 w-3" />
            </Link>
          </section>
        ) : role === "freelancer" ? (
          <section>
            <ListHead>Open jobs to propose on</ListHead>
            {!openJobs.length ? (
              <p className="mt-4 max-w-[60ch] text-sm text-faint">Nothing open right now. Check back — new jobs land once their poster locks the budget.</p>
            ) : (
              <JobRows jobs={openJobs.slice(0, 5)} />
            )}
            <Link href="/jobs" className={`mt-3 inline-flex items-center gap-1.5 text-[12px] text-faint hover:text-dim ${press}`}>
              all open jobs <ArrowRight className="h-3 w-3" />
            </Link>
          </section>
        ) : (
          <section>
            <div className="flex items-baseline justify-between">
              <ListHead>Dispute queue</ListHead>
              <Link href="/disputes" className="text-[12px] text-rose-bright hover:underline">open queue</Link>
            </div>
            {!openDisputes.length ? (
              <p className="mt-4 max-w-[60ch] text-sm text-faint">No open disputes. Selection is random among eligible stakes — stay eligible.</p>
            ) : (
              <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
                {openDisputes.slice(0, 5).map((d) => <DisputeRow key={d.id} dispute={d} />)}
              </div>
            )}
          </section>
        )}

        {/* chain pulse */}
        <section>
          <ListHead>Chain pulse</ListHead>
          <div className="mt-4 divide-y divide-white/[0.04] overflow-hidden rounded-3xl border border-line">
            {(ledger?.items ?? []).slice(0, 6).map((e) => (
              <div key={e.id} className="flex items-center gap-3 bg-white/[0.012] px-5 py-3.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ledgerDotColor(e.eventType) }} />
                <span className="num min-w-0 flex-1 truncate text-[12px] text-dim">
                  {e.eventType} {e.milestoneOnchainId !== null ? `· m${e.milestoneOnchainId}` : ""}
                </span>
                <span className="num text-[11px] text-faint">{timeAgo(e.blockTime)}</span>
              </div>
            ))}
            {!ledger?.items.length && <div className="px-5 py-4 text-sm text-faint">Waiting for chain events…</div>}
          </div>
          <Link href="/console" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-faint hover:text-dim">
            full ledger in the backend console <ArrowRight className="h-3 w-3" />
          </Link>
        </section>
      </div>
    </div>
  );
}

function greet(name: string, role: string): string {
  const first = name.split(" ")[0];
  if (role === "arbiter") return `Back on the bench, ${first}.`;
  if (role === "freelancer") return `Back to work, ${first}.`;
  return `Back to work, ${first}.`;
}

function ArbiterStats({ open, settled, serving }: { open: number; settled: number; serving: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-line py-7 md:grid-cols-4">
      <Stat label="open disputes" value={<span className="num text-rose-bright">{open}</span>} icon={open ? <Gavel className="h-4 w-4 text-rose-bright" /> : undefined} />
      <Stat label="settled" value={<span className="num">{settled}</span>} sub="majority decided" />
      <Stat label="serving" value={<span className="num">{serving}</span>} sub="projects in flight" />
      <Stat label="appeals" value={<span className="num">2 of 3</span>} sub="majority rules an appeal" />
    </div>
  );
}

function JobRows({ jobs }: { jobs: JobView[] }) {
  return (
    <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
      {jobs.map((j) => (
        <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between bg-white/[0.012] px-5 py-4 transition-colors hover:bg-white/[0.035]">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium">{j.title}</div>
            <div className="num mt-0.5 text-[11px] text-faint">{j.status.replace(/_/g, " ")} · {timeAgo(j.createdAt)}</div>
          </div>
          <StatusBadge status={j.status} />
        </Link>
      ))}
    </div>
  );
}

function DisputeRow({ dispute }: { dispute: DisputeView }) {
  return (
    <Link href="/disputes" className="flex items-center gap-3 bg-white/[0.012] px-5 py-4 transition-colors hover:bg-white/[0.035]">
      <StatusBadge status="disputed" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{dispute.reason || `round ${(dispute.round ?? 0) + 1} · ${dispute.phase}`}</span>
      <span className="num shrink-0 text-[11px] text-faint">{timeAgo(dispute.createdAt)}</span>
    </Link>
  );
}

function Stat({ label, value, sub, icon }: { label: string; value: React.ReactNode; sub?: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-medium tracking-tight">{value}</div>
      {sub && <div className="num mt-1 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

/** Loads the full project view for one card (milestones + parties). */
function ProjectCard({ id, jobId }: { id: string; jobId: string }) {
  const { data: p, isLoading } = useProject(id);
  const { data: job, isLoading: jobLoading } = useJob(jobId);
  const session = useSession();
  if (isLoading || !p) return <Skeleton className="h-48 rounded-3xl" />;
  const isClient = p.client.id === session.user?.id;
  const counterpart = isClient ? p.freelancer : p.client;
  const role = isClient ? "client" : "freelancer";

  return (
    <Link href={`/projects/${id}?fromJob=${jobId}`} className="group block min-w-0">
      <SpotCard className="glass h-full min-w-0 rounded-3xl p-6 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="num text-[11px] uppercase tracking-[0.16em] text-faint">
            {role} · vs {counterpart.displayName || <AddressText value={counterpart.walletAddress} size={3} />}
          </div>
          <div className="mt-2 line-clamp-2 text-[15.5px] font-medium leading-snug tracking-tight transition-colors group-hover:text-rose-bright">
            {job?.title ?? (jobLoading ? <Skeleton className="inline-block h-5 w-40 align-middle" /> : (p.milestones[0]?.title ?? "Project room"))}
          </div>
        </div>
        <StatusBadge status={p.status === "active" ? "funded" : p.status} />
      </div>

      {/* milestone rail */}
      <div className="mt-5 flex gap-1.5">
        {p.milestones.map((m) => (
          <div key={m.id} className="group/ms relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]" title={`${m.title} — ${m.chainStatus}`}>
            <div
              className="absolute inset-0 rounded-full transition-transform duration-700"
              style={{ background: STATE_COLORS[m.chainStatus] ?? "var(--color-state-pending)", opacity: 0.85 }}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {p.milestones.map((m) => (
            <span key={m.id} className="num flex items-center gap-1.5 text-[11px] text-faint">
              <span className="h-1 w-1 rounded-full" style={{ background: STATE_COLORS[m.chainStatus] ?? "var(--color-state-pending)" }} aria-hidden />
              m{m.position}
            </span>
          ))}
        </div>
        <EthAmount wei={p.milestones.reduce((a, m) => a + toWei(m.amountWei), 0n)} className="text-sm text-dim" />
      </div>
      </SpotCard>
    </Link>
  );
}
