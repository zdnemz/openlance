"use client";

/** /jobs/new — post a job with a milestone builder; sum must fit budget. */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { post } from "@/lib/queries";
import { SectionLabel, press } from "@/components/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";

interface Draft {
  title: string;
  description: string;
  category: string;
  skills: string;
  budgetMin: string;
  budgetMax: string;
  milestones: { title: string; description: string; amount: string }[];
}

const START: Draft = {
  title: "",
  description: "",
  category: "frontend",
  skills: "",
  budgetMin: "0.1",
  budgetMax: "0.5",
  milestones: [{ title: "", description: "", amount: "" }],
};

const CATEGORIES = ["frontend", "backend", "contracts", "security", "design", "other"];

export default function NewJobPage() {
  const session = useSession();
  const router = useRouter();
  const [d, setD] = useState<Draft>(START);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const total = d.milestones.reduce((acc, m) => acc + (Number(m.amount) || 0), 0);
  const min = Number(d.budgetMin) || 0;
  const max = Number(d.budgetMax) || 0;
  const sumFits = total >= min && total <= max && total > 0;

  if (!session.token) {
    return (
      <div className="mx-auto max-w-md pt-24 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Post a job</h1>
        <p className="mt-4 text-sm leading-relaxed text-dim">
          Connect a wallet and prove ownership first — jobs are posted by their wallet identity, and escrow funds
          will flow from that same address.
        </p>
        <Link href="/jobs" className="mt-6 inline-block text-sm text-rose-bright hover:underline">
          Back to the marketplace
        </Link>
      </div>
    );
  }

  async function submit() {
    setError(null);
    if (d.title.trim().length < 4) return setError("Give the job a real title (4+ characters).");
    if (d.description.trim().length < 20) return setError("The brief needs at least 20 characters — describe the work and the acceptance bar.");
    if (min <= 0 || max <= 0 || min > max) return setError("Budget range must be positive, with min ≤ max.");
    if (!d.milestones.length || !d.milestones.every((m) => m.title.trim() && m.description.trim() && /^\d*\.?\d+$/.test(m.amount)))
      return setError("Every milestone needs a title, a description, and a valid ETH amount.");
    if (!sumFits) return setError(`Milestone sum (${total.toFixed(3)} ETH) must land inside the budget range ${min}–${max} ETH. The server re-checks this.`);
    setSubmitting(true);
    try {
      const job = await post<{ id: string }>("/jobs", {
        title: d.title.trim(),
        description: d.description.trim(),
        category: d.category,
        skills: d.skills.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 15),
        budgetMin: d.budgetMin,
        budgetMax: d.budgetMax,
        milestones: d.milestones.map((m) => ({ title: m.title.trim(), description: m.description.trim(), amount: m.amount })),
      });
      toast.success("Job posted", { description: "It's live in the marketplace with its milestone template." });
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionLabel>new job</SectionLabel>
      <h1 className="mt-2.5 text-3xl font-semibold tracking-tighter md:text-4xl">Break the work into escrowable chunks.</h1>
      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-dim">
        The milestone template is the contract's blueprint. Each milestone gets funded, delivered, submitted, and
        released on its own — the sum must fit the budget range you declare.
      </p>

      <div className="glass mt-10 space-y-6 rounded-3xl p-7 md:p-9">
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Title</label>
          <Input
            value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })}
            placeholder="Invariant fuzz audit for a cross-chain bridge (Foundry)"
            className="h-11 border-line bg-white/[0.03] text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-[13px] font-medium">The brief</label>
          <Textarea
            value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })}
            rows={7}
            placeholder="Context, scope, acceptance criteria, what the reviewer checks at each milestone. Markdown-ish paragraphs work well."
            className="resize-none border-line bg-white/[0.03] text-sm"
          />
          <p className="text-[11px] text-faint">Minimum 20 characters. This is what proposals will be written against.</p>
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">Category</label>
            <select
              value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}
              className="h-11 w-full rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none focus:border-rose-accent/50"
            >
              {CATEGORIES.map((c) => <option key={c} value={c} className="bg-ink-raised">{c}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[13px] font-medium">Budget min (ETH)</label>
            <Input value={d.budgetMin} onChange={(e) => setD({ ...d, budgetMin: e.target.value })} className="num h-11 border-line bg-white/[0.03] text-sm" />
          </div>
          <div className="space-y-2">
            <label className="text-[13px] font-medium">Budget max (ETH)</label>
            <Input value={d.budgetMax} onChange={(e) => setD({ ...d, budgetMax: e.target.value })} className="num h-11 border-line bg-white/[0.03] text-sm" />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[13px] font-medium">Skills</label>
          <Input
            value={d.skills} onChange={(e) => setD({ ...d, skills: e.target.value })}
            placeholder="solidity, foundry, fuzzing"
            className="h-11 border-line bg-white/[0.03] text-sm"
          />
          <p className="text-[11px] text-faint">Comma-separated, up to 15.</p>
        </div>

        {/* milestone builder */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-medium">Milestone template</label>
            <button
              type="button"
              onClick={() => setD({ ...d, milestones: [...d.milestones, { title: "", description: "", amount: "" }] })}
              className={`flex items-center gap-1.5 text-[12px] text-rose-bright hover:underline ${press}`}
            >
              <Plus className="h-3.5 w-3.5" /> add milestone
            </button>
          </div>
          {d.milestones.map((m, i) => (
            <div key={i} className="space-y-2.5 rounded-2xl border border-line bg-white/[0.02] p-5">
              <div className="flex items-center gap-3">
                <span className="num text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                <Input
                  value={m.title}
                  onChange={(e) => setD({ ...d, milestones: d.milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                  placeholder="Threat model + attack surface map"
                  className="h-10 flex-1 border-line bg-white/[0.03] text-[13.5px]"
                />
                <Input
                  value={m.amount}
                  onChange={(e) => setD({ ...d, milestones: d.milestones.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })}
                  placeholder="0.00"
                  className="num h-10 w-28 shrink-0 border-line bg-white/[0.03] text-[13.5px]"
                />
                {d.milestones.length > 1 && (
                  <button type="button" aria-label="Remove" onClick={() => setD({ ...d, milestones: d.milestones.filter((_, j) => j !== i) })} className="shrink-0 text-faint transition-colors hover:text-destructive">
                    <Trash className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Textarea
                value={m.description} rows={2}
                onChange={(e) => setD({ ...d, milestones: d.milestones.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                placeholder="What gets delivered, and what the reviewer checks before release"
                className="resize-none border-line bg-white/[0.03] text-[13px]"
              />
            </div>
          ))}

          <div className={`flex items-center justify-between rounded-2xl px-5 py-4 transition-colors ${sumFits ? "bg-white/[0.04]" : "bg-amber-400/[0.07]"}`}>
            <span className="flex items-center gap-2.5">
              {sumFits ? (
                <span className="num text-[11px] uppercase tracking-wider text-faint">template sum</span>
              ) : (
                <span className="flex items-center gap-2 text-[12px] text-amber-300">
                  <Warning weight="bold" className="h-3.5 w-3.5" /> sum must fit {min}–{max} ETH
                </span>
              )}
            </span>
            <span className={`num text-lg font-medium ${sumFits ? "text-rose-bright" : "text-amber-300"}`}>
              {total.toFixed(3)} ETH
            </span>
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">
            <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        <Button onClick={submit} disabled={submitting} className="w-full rounded-full bg-rose-accent py-3.5 text-sm font-medium hover:bg-rose-bright">
          {submitting ? "Posting…" : <span className="flex items-center gap-2">Post job <ArrowRight className="h-4 w-4" weight="bold" /></span>}
        </Button>
      </div>
    </div>
  );
}
