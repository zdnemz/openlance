"use client";

/** /dashboard — role-aware control room: work in flight, money state. */
import Link from "next/link";
import { useProjects, useJobs, useDisputes, useProject, useLedger } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { EthAmount, Skeleton, EmptyState, SectionLabel, StatusBadge, AddressText, press } from "@/components/design";
import { STATE_COLORS, timeAgo } from "@/lib/format";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Briefcase } from "@phosphor-icons/react/dist/csr/Briefcase";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { TrendUp } from "@phosphor-icons/react/dist/csr/TrendUp";
import { TrendDown } from "@phosphor-icons/react/dist/csr/TrendDown";

export default function DashboardPage() {
  const session = useSession();
  const { data: projects, isLoading } = useProjects();
  const { data: allJobs } = useJobs();
  const { data: disputes } = useDisputes();
  const { data: ledger } = useLedger({ limit: "8" });

  if (!session.token) {
    return (
      <EmptyState
        className="mt-16"
        title="Your dashboard lives behind your key"
        body="Connect a wallet and prove ownership — projects, escrow states, and earnings are scoped to your address. Pick a devnet persona for an instant view."
        action={<Link href="/jobs" className="text-sm text-rose-bright hover:underline">Browse jobs meanwhile</Link>}
      />
    );
  }

  const me = session.user!;
  const myJobs = (allJobs?.items ?? []).filter((j) => j.poster?.id === me.id);
  const active = (projects ?? []).filter((p) => p.status === "active");
  const done = (projects ?? []).filter((p) => p.status === "completed");
  const openDisputes = (disputes ?? []).filter((d) => d.status !== "resolved");

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>dashboard</SectionLabel>
          <h1 className="mt-2.5 text-3xl font-semibold tracking-tighter md:text-4xl">
            {me.displayName ? `Back to work, ${me.displayName.split(" ")[0]}.` : "Your work."}
          </h1>
        </div>
        <Link href="/jobs" className={`flex items-center gap-1.5 text-sm text-dim hover:text-foreground ${press}`}>
          Find more work <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* stat strip — hairlines, no boxes (density 4) */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-line py-7 md:grid-cols-4">
        <Stat label="earned on-chain" value={<EthAmount wei={me.stats.totalEarnedWei} />} icon={<TrendUp className="h-4 w-4 text-state-released" />} />
        <Stat label="paid through escrow" value={<EthAmount wei={me.stats.totalPaidWei} />} icon={<TrendDown className="h-4 w-4 text-state-submitted" />} />
        <Stat label="projects in flight" value={<span className="num">{active.length}</span>} sub={`${done.length} completed`} />
        <Stat label="open disputes" value={<span className="num">{openDisputes.length}</span>} icon={openDisputes.length ? <Gavel className="h-4 w-4 text-state-disputed" /> : undefined} />
      </div>

      {/* active projects */}
      <section>
        <div className="flex items-baseline justify-between">
          <SectionLabel>active projects</SectionLabel>
          <span className="num text-[11px] text-faint">{projects?.length ?? 0} total</span>
        </div>
        {isLoading ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Skeleton className="h-44 rounded-3xl" />
            <Skeleton className="h-44 rounded-3xl" />
          </div>
        ) : !projects?.length ? (
          <EmptyState
            className="mt-5"
            icon={<Briefcase className="h-5 w-5" />}
            title="No projects yet"
            body="Post a job and award a proposal, or propose on open work — the project room is where escrow happens."
            action={<Link href="/jobs" className="text-sm text-rose-bright hover:underline">Explore the marketplace</Link>}
          />
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {projects.map((p) => <ProjectCard key={p.id} id={p.id} />)}
          </div>
        )}
      </section>

      <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
        {/* my open jobs */}
        <section>
          <SectionLabel>your open jobs</SectionLabel>
          {!myJobs.length ? (
            <p className="mt-4 text-sm text-faint">Nothing posted — <Link href="/jobs/new" className="text-rose-bright hover:underline">post one</Link> with its milestone template.</p>
          ) : (
            <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
              {myJobs.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between bg-white/[0.012] px-5 py-4 transition-colors hover:bg-white/[0.035]">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{j.title}</div>
                    <div className="num mt-0.5 text-[11px] text-faint">{j.status.replace("_", " ")} · {timeAgo(j.createdAt)}</div>
                  </div>
                  <StatusBadge status={j.status} />
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* chain pulse */}
        <section>
          <SectionLabel>chain pulse</SectionLabel>
          <div className="mt-4 divide-y divide-white/[0.04] overflow-hidden rounded-3xl border border-line">
            {(ledger?.items ?? []).slice(0, 6).map((e) => (
              <div key={e.id} className="flex items-center gap-3 bg-white/[0.012] px-5 py-3.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ledgerColor(e.eventType) }} />
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
function ProjectCard({ id }: { id: string }) {
  const { data: p, isLoading } = useProject(id);
  const session = useSession();
  if (isLoading || !p) return <Skeleton className="h-44 rounded-3xl" />;
  const isClient = p.client.id === session.user?.id;
  const counterpart = isClient ? p.freelancer : p.client;
  const role = isClient ? "client" : "freelancer";

  return (
    <Link href={`/projects/${id}`} className="glass group block rounded-3xl p-6 transition-all hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="num text-[10px] uppercase tracking-[0.16em] text-faint">
            {role} · vs {counterpart.displayName ?? <AddressText value={counterpart.walletAddress} size={3} />}
          </div>
          <div className="mt-2 truncate text-[15.5px] font-medium tracking-tight">
            {p.jobId ? "" : ""}project {id.slice(0, 8)}
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
            <span key={m.id} className="num text-[11px]" style={{ color: STATE_COLORS[m.chainStatus] }}>
              m{m.position}
            </span>
          ))}
        </div>
        <EthAmount wei={p.milestones.reduce((a, m) => a + BigInt(m.amountWei), 0n)} className="text-sm text-dim" />
      </div>
    </Link>
  );
}

function ledgerColor(eventType: string): string {
  if (eventType.includes("Released") || eventType.includes("Split")) return "#34d399";
  if (eventType.includes("Dispute")) return "#fb923c";
  if (eventType.includes("Funded")) return "#fbbf24";
  if (eventType.includes("Trust") || eventType.includes("Arbiter")) return "#f43f5e";
  if (eventType.includes("Fee")) return "#5eead4";
  return "#a1a1aa";
}
