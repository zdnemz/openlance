"use client";

/** /jobs — the marketplace: asymmetric list, filters, milestone-sum chips. */
import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useJobs } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { AddressAvatar, Chip, Skeleton, EmptyState, press } from "@/components/design";
import { PageHeader } from "@/components/page-header";
import { RoleGate } from "@/components/role-gate";
import { formatEth, timeAgo } from "@/lib/format";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Briefcase } from "@phosphor-icons/react/dist/csr/Briefcase";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Funnel } from "@phosphor-icons/react/dist/csr/Funnel";

const CATEGORIES = ["all", "security", "contracts", "frontend", "backend", "design"];

export default function JobsPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (category !== "all") f.category = category;
    if (q.trim()) f.q = q.trim();
    return f;
  }, [category, q]);

  const { data, isLoading, error } = useJobs(filters);
  const session = useSession();
  const isClient = !!session.token && session.user?.role === "client";
  const { data: drafts } = useJobs({ status: "draft" }, isClient);

  return (
    <RoleGate>
    <div>
      <PageHeader
        title="Open work"
        desc="Jobs posted with milestone templates: the sum the client expects to escrow, broken into reviewable chunks before anyone starts."
        meta={data ? <>{data.items.length} {data.items.length === 1 ? "listing" : "listings"}<br />milestone sums pre-validated</> : undefined}
        actions={
          session.token && session.user?.role === "client" ? (
            <Link
              href="/jobs/new"
              className={`inline-flex items-center gap-2 rounded-full bg-rose-accent px-5 py-2.5 text-[13px] font-medium text-white hover:bg-rose-bright ${press}`}
            >
              Post a job
            </Link>
          ) : undefined
        }
      />

      <div className="mt-9 flex flex-wrap items-center gap-2.5">
        <label className="relative flex-1 basis-64">
          <MagnifyingGlass className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            // The <label> wraps the field but holds no text, so it provided no
            // accessible name at all — the field announced as a bare edit box.
            aria-label="Search job titles"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles…"
            className="h-11 w-full rounded-full border border-line bg-white/[0.03] pl-11 pr-4 text-sm outline-none transition-colors placeholder:text-faint focus:border-rose-accent/50"
          />
        </label>
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          <Funnel className="mr-1 h-3.5 w-3.5 shrink-0 text-faint" />
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs ${press} ${
                category === c
                  ? "border-rose-accent/40 bg-rose-soft text-rose-bright"
                  : "border-line text-dim hover:border-line-strong hover:text-foreground"
              }`}
              aria-pressed={category === c}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8">
        {isClient && !!drafts?.items.length && (
          <div className="mb-8 overflow-hidden rounded-3xl border border-amber-400/25 bg-amber-400/[0.04]">
            <div className="px-6 pt-5">
              <span className="num text-[11px] uppercase tracking-wider text-amber-300">your drafts · deposit to publish</span>
            </div>
            <div className="divide-y divide-white/[0.05]">
              {drafts.items.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="group flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-white/[0.03]"
                >
                  <span className="min-w-0 truncate text-[14px] font-medium">{job.title}</span>
                  <span className="num shrink-0 text-[12px] text-amber-300">
                    {formatEth(job.budget.maxWei)} ETH to publish →
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
        {isLoading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 w-full rounded-3xl" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={<Briefcase className="h-5 w-5" />}
            title="The marketplace is unreachable"
            body="The API may still be booting the chain stack. Give it a minute and refresh — the devnet redeploys contracts on boot."
          />
        ) : !data?.items.length ? (
          <EmptyState
            icon={<Briefcase className="h-5 w-5" />}
            title="Nothing matches that filter"
            body="Try another category, or clear the search. New jobs land here the moment their milestone template validates."
          />
        ) : (
          <div className="divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
            {data.items.map((job, i) => (
              <motion.div
                key={job.id}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, type: "spring", stiffness: 120, damping: 20 }}
              >
                <Link
                  href={`/jobs/${job.id}`}
                  className="group flex flex-col gap-4 bg-white/[0.012] px-6 py-6 transition-colors hover:bg-white/[0.035] sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="num rounded-md bg-white/[0.05] px-2 py-0.5 text-[11px] uppercase tracking-wider text-dim">
                        {job.category}
                      </span>
                      <span className="num text-[11px] text-faint">{timeAgo(job.createdAt)}</span>
                    </div>
                    <h2 className="mt-2 text-[17px] font-medium leading-snug tracking-tight transition-colors group-hover:text-rose-bright">
                      {job.title}
                    </h2>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {job.skills.slice(0, 5).map((s) => (
                        <Chip key={s}>{s}</Chip>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-6 sm:flex-col sm:items-end sm:gap-1.5">
                    <div className="text-right">
                      <div className="num text-xl font-medium tracking-tight">
                        {formatEth(job.budget.maxWei)} <span className="text-xs text-faint">ETH</span>
                      </div>
                      <div className="num mt-0.5 text-[12px] text-faint">max budget</div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-70" />
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
    </RoleGate>
  );
}
