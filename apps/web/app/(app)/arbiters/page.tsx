"use client";

/**
 * /arbiters — the trust registry as a ranked ledger: hairline rows, ghost
 * rank numerals, right-aligned trust. No card grid — a registry reads as
 * a table of record, not a wall of identical boxes.
 *
 * Every status shown here is derived from the on-chain Registry rules:
 * eligible (drawable) · unstaking (benched) · locked (score < floor) — see
 * contracts/contracts/ArbiterRegistry.sol isEligible/isLocked.
 */
import { useArbiters, useProjects, useJob, useInvalidate, post } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { AddressAvatar, EmptyState, ArbiterRegistrySkeleton, press } from "@/components/design";
import { PageHeader } from "@/components/page-header";
import { RoleGate } from "@/components/role-gate";
import { ArbiterStakeSummary } from "@/components/arbiter-stake-panel";
import { shortAddress, dateLabel, formatEth, timeUntil } from "@/lib/format";
import { TIER_NAMES, arbiterStanding } from "@/lib/roles";
import { useRuntime } from "@/lib/runtime";
import { Button } from "@/components/ui/button";
import { AddressText, ListHead } from "@/components/design";
import { toast } from "sonner";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import Link from "next/link";
import { useState } from "react";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import type { ArbiterView, ProjectView } from "@/lib/types";

/**
 * The arbiter's standing, mirroring the registry. Shared with the profile card
 * via `arbiterStanding` in @/lib/roles — one vocabulary for one registry state.
 */

export default function ArbitersPage() {
  const { data: arbiters, isLoading } = useArbiters();
  const minStakeWei = useRuntime((s) => s.minStakeWei);
  const minScore = useRuntime((s) => s.minScoreToWithdraw);
  const registered = (arbiters ?? []).filter((a) => a.registered);
  // ranked by trust, then by SLA discipline — ties keep registration order
  const ranked = [...registered].sort((a, b) => b.trustScore - a.trustScore || b.resolutionsWithinSla - a.resolutionsWithinSla);
  const eligibleCount = registered.filter((a) => a.eligible).length;

  // Arbiter seating: pick a project you're a party to, choose up to 3 arbiters
  // from this roster, propose; the counterparty approves to lock them in.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  function togglePick(address: string) {
    setSelected((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address)
        : prev.length >= 3 ? prev
          : [...prev, address],
    );
  }

  function chooseProject(id: string | null) {
    setProjectId(id);
    setSelected([]);
  }

  return (
    <RoleGate>
    <div className="space-y-9">
      <PageHeader
        title="Arbiters stake their name."
        desc={
          <>
            Arbiters bond ETH collateral and hold a soulbound badge (ERC-5194). Trust score runs{" "}
            <span className="num text-foreground">0–100</span>: you start at 100, gain{" "}
            <span className="num text-state-released">+5</span> for a majority vote, and lose{" "}
            <span className="num text-state-disputed">−10</span> minority,{" "}
            <span className="num text-state-disputed">−15</span> missed deadline,{" "}
            <span className="num text-state-disputed">−25</span> overturned. Below a score of{" "}
            <span className="num text-foreground">{minScore}</span> the stake locks and you drop out of selection;
            hit <span className="num text-foreground">0</span> and the whole stake is slashed to the treasury.
          </>
        }
        meta={registered.length > 0 ? <>{registered.length} registered<br /><span className="text-state-released">{eligibleCount}</span> eligible for selection</> : undefined}
      />

      <ArbiterStakeSummary />

      <ArbiterPicker
        eligible={registered.filter((a) => a.eligible)}
        projectId={projectId}
        onChooseProject={chooseProject}
        selected={selected}
        onToggle={togglePick}
      />

      {isLoading ? (
        <ArbiterRegistrySkeleton />
      ) : !registered.length ? (
        <EmptyState
          icon={<Scales className="h-5 w-5" />}
          title="No registered arbiters yet"
          body="Be the first — stake collateral above to join the pool. New arbiters start at trust score 100."
        />
      ) : (
        <ol className="divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
          {ranked.map((a, i) => {
            const st = arbiterStanding(a, minStakeWei);
            const tierName = (TIER_NAMES[a.tier ?? 0] ?? "Unstaked").toLowerCase();
            const belowMinStake = (() => { try { return BigInt(a.stakeWei || "0") < BigInt(minStakeWei || "0"); } catch { return false; } })();
            const pickable = !!projectId && a.eligible;
            const picked = selected.includes(a.address);
            return (
              <li key={a.address} className={picked ? "bg-rose-soft/40" : undefined}>
                <Link
                  href={`/profile/${a.address}`}
                  className={`group relative flex flex-col gap-4 bg-white/[0.012] px-6 py-6 transition-colors hover:bg-white/[0.035] md:flex-row md:items-center ${press}`}
                >
                  {i === 0 && <span aria-hidden className="absolute inset-y-0 left-0 w-[2.5px] bg-rose-bright" />}
                  {/* pick checkbox — only while seating arbiters on a project */}
                  {pickable && (
                    <button
                      type="button"
                      aria-label={picked ? "Deselect arbiter" : "Select arbiter"}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePick(a.address); }}
                      className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        picked ? "border-rose-accent bg-rose-accent text-white" : "border-line-strong text-transparent hover:border-rose-accent/60"
                      }`}
                    >
                      <Check weight="bold" className="h-4 w-4" />
                    </button>
                  )}
                  {/* rank */}
                  <span
                    aria-hidden
                    className={`num w-10 shrink-0 select-none text-[30px] font-semibold leading-none tracking-tighter ${
                      i === 0 ? "text-rose-bright/60" : "ghost-num"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {/* identity */}
                  <span className="flex min-w-0 flex-1 items-center gap-3.5">
                    <AddressAvatar address={a.address} size={44} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[15.5px] font-medium transition-colors group-hover:text-rose-bright">
                          {a.profile?.displayName ?? shortAddress(a.address)}
                        </span>
                        <SealCheck weight="fill" className="h-4 w-4 shrink-0 text-rose-bright" />
                        <span
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                          style={{
                            color: st.color,
                            borderColor: `color-mix(in oklab, ${st.color} 32%, transparent)`,
                            background: `color-mix(in oklab, ${st.color} 9%, transparent)`,
                          }}
                        >
                          {st.label}
                        </span>
                      </span>
                      <span className="num mt-0.5 block text-[12px] text-faint">
                        {a.registeredAt ? `registered ${dateLabel(a.registeredAt)}` : "registered"} · badge {a.sbtTokenId ? `#${a.sbtTokenId}` : "pending"} · {tierName}
                        {st.label === "staked" && a.selectableAfter ? ` · selectable ${timeUntil(a.selectableAfter)}` : ""}
                        {a.kycStatus && a.kycStatus !== "verified" ? ` · kyc ${a.kycStatus}` : ""}
                      </span>
                    </span>
                  </span>
                  {/* record — hairline columns, left-aligned */}
                  <span className="flex items-center gap-0 divide-x divide-white/[0.07] md:gap-6">
                    <span className="pr-5 text-left md:pr-6">
                      <span className="num block text-lg font-medium leading-none">{a.resolutions}</span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">resolved</span>
                    </span>
                    <span className="px-5 text-left md:px-6">
                      <span className="num block text-lg font-medium leading-none text-state-released">{a.resolutionsWithinSla}</span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">within SLA</span>
                    </span>
                    <span className="px-5 text-left md:px-6">
                      <span className={`num block text-lg font-medium leading-none ${a.resolutionsLate > 0 ? "text-state-disputed" : "text-dim"}`}>
                        {a.resolutionsLate}
                      </span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">late</span>
                    </span>
                    <span className="px-5 text-left md:px-6">
                      <span className="num block text-lg font-medium leading-none text-rose-bright">
                        {formatEth(a.totalEarnedWei)}
                      </span>
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-faint">earned</span>
                    </span>
                  </span>
                  {/* stake — the skin in the game */}
                  <span className="flex items-baseline justify-between gap-2 border-t border-line pt-4 md:w-24 md:flex-col md:items-end md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <span className={`num text-lg font-medium leading-none ${belowMinStake ? "text-state-disputed" : "text-dim"}`}>
                      {formatEth(a.stakeWei)}
                    </span>
                    <span className="num text-[11px] uppercase tracking-[0.16em] text-faint">ETH · {tierName}</span>
                  </span>
                  {/* trust — the verdict, right rail */}
                  <span className="flex items-baseline justify-between gap-2 border-t border-line pt-4 md:w-24 md:flex-col md:items-end md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <span className={`num text-4xl font-medium leading-none tracking-tight ${a.trustScore > 0 ? "text-state-released" : "text-dim"}`}>
                      {a.trustScore}
                    </span>
                    <span className="num text-[11px] uppercase tracking-[0.16em] text-faint">trust</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
    </RoleGate>
  );
}

/* ── seat arbiters on a project from this roster ──────────────────────── */

/**
 * Pick an active project you're a party to, choose up to 3 eligible arbiters
 * from the roster below (their rows grow a checkbox), then propose. The
 * counterparty approves to lock the seats — the same propose/approve API the
 * project room uses, but driven from the roster instead of typed addresses.
 */
/**
 * Project seat option labeled by job title (never an id).
 */
function ProjectOption({ project: p }: { project: ProjectView }) {
  const { data: job } = useJob(p.jobId);
  return (
    <option value={p.id} className="bg-ink">
      {job?.title ?? p.milestones?.[0]?.title ?? "Project room"}
    </option>
  );
}

function ArbiterPicker({
  eligible,
  projectId,
  onChooseProject,
  selected,
  onToggle,
}: {
  eligible: ArbiterView[];
  projectId: string | null;
  onChooseProject: (id: string | null) => void;
  selected: string[];
  onToggle: (address: string) => void;
}) {
  const session = useSession();
  const { data: projects } = useProjects();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);

  const seatable = (projects ?? []).filter((p) => {
    const locked = (p.chosenArbiters ?? []) as string[];
    return p.status === "active" && !locked.length && !p.arbitersLockedAt;
  });
  const project = seatable.find((p) => p.id === projectId) ?? null;
  const proposal = (project?.arbiterProposal ?? null) as { proposerId: string; addresses: string[] } | null;
  const mine = !!proposal && proposal.proposerId === session.user?.id;
  const eligibleSet = new Set(eligible.map((a) => a.address.toLowerCase()));
  const picked = selected.filter((a) => eligibleSet.has(a.toLowerCase()));

  async function propose() {
    if (!project) return;
    if (picked.length < 1) {
      toast.error("Pick at least one arbiter", { description: "Select up to 3 eligible arbiters from the roster." });
      return;
    }
    setBusy(true);
    try {
      await post(`/projects/${project.id}/arbiters/propose`, { addresses: picked });
      invalidate.projects();
      onChooseProject(project.id);
      toast.success("Arbiters proposed", { description: "The counterparty approves to lock them in." });
    } catch (err) {
      toast.error("Could not propose", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!project) return;
    setBusy(true);
    try {
      await post(`/projects/${project.id}/arbiters/approve`, {});
      invalidate.projects();
      onChooseProject(null);
      toast.success("Arbiters locked", { description: "They seat first if a milestone ever disputes." });
    } catch (err) {
      toast.error("Could not lock", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  if (!session.token) return null;

  return (
    <section className="glass rounded-3xl p-6">
      <div className="flex items-center gap-2.5">
        <Scales className="h-4 w-4 text-dim" />
        <ListHead>Seat arbiters on a project</ListHead>
      </div>
      <p className="mt-2.5 max-w-[62ch] text-[13px] leading-relaxed text-dim">
        Choose an active project you're part of, then tick up to three eligible arbiters from the roster below. The
        other party approves and the seats lock — disputed milestones then draw these arbiters first.
      </p>

      {!seatable.length ? (
        <p className="mt-4 text-[12.5px] text-faint">
          No active project is awaiting arbiters. Seats can be picked once you're on an active project.
        </p>
      ) : proposal && !mine ? (
        <div className="mt-4 rounded-2xl border border-line bg-white/[0.02] p-4">
          <div className="num text-[11px] uppercase tracking-wider text-faint">counterparty proposal — approve to lock</div>
          <div className="mt-2 space-y-1.5">
            {proposal.addresses.map((a) => (
              <Link key={a} href={`/profile/${a}`} className="block transition-colors hover:text-rose-bright">
                <AddressText value={a} className="text-[13px]" />
              </Link>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2.5">
            <Button disabled={busy} onClick={approve} className="rounded-full bg-state-released px-5 py-2 text-[12.5px] font-medium text-ink hover:brightness-110">
              Approve + lock
            </Button>
            <Button disabled={busy} onClick={() => onChooseProject(null)} className="rounded-full bg-white/10 px-5 py-2 text-[12.5px] font-medium hover:bg-white/20">
              Dismiss
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block space-y-2">
            <span className="text-[13px] font-medium">Project</span>
            <select
              value={projectId ?? ""}
              onChange={(e) => onChooseProject(e.target.value || null)}
              className="h-11 w-full rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors focus:border-rose-accent/50"
            >
              <option value="">Select a project…</option>
              {seatable.map((p) => (
                <ProjectOption key={p.id} project={p} />
              ))}
            </select>
          </label>

          {project && (
            <div className="rounded-2xl border border-line bg-white/[0.02] p-4">
              <div className="flex items-center justify-between">
                <span className="num text-[11px] uppercase tracking-wider text-faint">
                  selected {picked.length}/3
                </span>
                {picked.length > 0 && (
                  <button type="button" onClick={() => picked.forEach(onToggle)} className="text-[12px] text-faint hover:text-foreground">
                    clear
                  </button>
                )}
              </div>
              {picked.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-faint">Tick arbiters in the roster below — eligible (green) rows only.</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {picked.map((a) => (
                    <Link key={a} href={`/profile/${a}`} className="block transition-colors hover:text-rose-bright">
                      <AddressText value={a} className="text-[13px]" />
                    </Link>
                  ))}
                </div>
              )}
              {mine && (
                <p className="mt-3 text-[12px] text-amber-300">You proposed these — waiting on the counterparty to approve.</p>
              )}
              <Button
                disabled={busy || picked.length === 0 || mine}
                onClick={propose}
                className="mt-3 rounded-full bg-rose-accent px-5 py-2 text-[12.5px] font-medium hover:bg-rose-bright"
              >
                {mine ? "Proposed" : busy ? "Proposing…" : `Propose ${picked.length || ""} arbiter${picked.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
