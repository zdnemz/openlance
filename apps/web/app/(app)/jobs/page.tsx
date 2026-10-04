"use client";

/** /jobs — the marketplace: asymmetric list, filters, milestone-sum chips. */
import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useJobs } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { Chip, Skeleton, EmptyState, press } from "@/components/design";
import { buttonVariants } from "@/components/ui/button";
import { stepTransition } from "@/components/motion";
import { PageHeader } from "@/components/page-header";
import { RoleGate } from "@/components/role-gate";
import { formatEth, timeAgo } from "@/lib/format";
import { ArrowUpRight, Briefcase, Funnel, MagnifyingGlass } from "@/components/icons";
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
            <Link href="/jobs/new" className={buttonVariants()}>
              Post a job
            </Link>
          ) : undefined
        }
      />

      <div className="mt-9 flex flex-wrap items-center gap-2.5">
        <label className="relative flex-1 basis-64">
          <MagnifyingGlass className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-faint" />
          <input
            // The <label> wraps the field but holds no text, so it provided no
            // accessible name at all — the field announced as a bare edit box.
            aria-label="Search job titles"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles…"
            className="pixel-well h-12 w-full pl-11 pr-4 text-base outline-none transition-colors placeholder:text-faint focus:border-rose-light"
          />
        </label>
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          <Funnel className="mr-1 h-5 w-5 shrink-0 text-faint" />
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`shrink-0 cursor-pointer border-2 px-3.5 py-2 text-[14px] ${press} ${
                category === c
                  ? "border-rose-accent bg-rose-soft text-white"
                  : "border-line-strong text-dim hover:border-rose-light hover:text-foreground"
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
          <div className="mb-8 overflow-hidden border-2 border-state-funded/60 bg-state-funded/[0.05]">
            <div className="px-6 pt-5">
              <span className="font-display text-[11px] uppercase text-state-funded">your drafts · deposit to publish</span>
            </div>
            <div className="divide-y-2 divide-line">
              {drafts.items.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="group flex min-h-14 items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-ink-hover"
                >
                  <span className="min-w-0 truncate text-[15px] font-medium">{job.title}</span>
                  <span className="num shrink-0 text-[13px] text-state-funded">
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
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={<Briefcase />}
            title="The marketplace is unreachable"
            body="The API may still be booting the chain stack. Give it a minute and refresh — the devnet redeploys contracts on boot."
          />
        ) : !data?.items.length ? (
          <EmptyState
            sprite="chest"
            title="Nothing matches that filter"
            body="Try another category, or clear the search. New jobs land here the moment their milestone template validates."
          />
        ) : (
          <div className="divide-y-2 divide-line overflow-hidden border-2 border-line">
            {data.items.map((job, i) => (
              <motion.div
                key={job.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={stepTransition(0.3, 4, i * 0.06)}
              >
                <Link
                  href={`/jobs/${job.id}`}
                  className="group flex flex-col gap-4 bg-ink-raised px-6 py-6 transition-colors hover:bg-ink-hover sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="border-2 border-line bg-ink-hover px-2 py-0.5 text-[13px] font-semibold uppercase tracking-wide text-dim">
                        {job.category}
                      </span>
                      <span className="num text-[13px] text-faint">{timeAgo(job.createdAt)}</span>
                    </div>
                    <h2 className="mt-3 text-[19px] font-semibold leading-snug transition-colors group-hover:text-rose-light">
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
                      <div className="display text-[15px] leading-none">
                        {formatEth(job.budget.maxWei)} <span className="text-[11px] text-faint">ETH</span>
                      </div>
                      <div className="num mt-2 text-[13px] text-faint">max budget</div>
                    </div>
                    <ArrowUpRight className="h-6 w-6 text-faint opacity-0 transition-opacity group-hover:opacity-80" />
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
