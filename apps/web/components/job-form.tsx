"use client";

/** Shared job draft form — /jobs/new (create) and draft detail (full edit). */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { post, patch, useInvalidate } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { X } from "@phosphor-icons/react/dist/csr/X";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Chip } from "@/components/design";

export interface JobDraft {
  title: string;
  description: string;
  category: string;
  customCategory: string;
  skills: string;
  budget: string;
}

const START: JobDraft = {
  title: "",
  description: "",
  category: "frontend",
  customCategory: "",
  skills: "",
  budget: "0.5",
};

export const CATEGORIES = ["frontend", "backend", "contracts", "security", "design", "other"];
export const CUSTOM_CATEGORY = "custom";
const PRESET_SKILLS = [
  "solidity", "foundry", "fuzzing", "auditing", "formal-verification",
  "react", "typescript", "next.js", "rust", "cairo", "design", "writing",
];

function skillTokens(skills: string): string[] {
  return skills.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Job post: a brief and a ceiling. The milestone breakdown is the freelancer's
 * to shape — each bid brings its own — so the only number the client commits to
 * here is the maximum they are willing to pay. Nothing is escrowed at this point;
 * the client signs the winning bid once, at award.
 */
export function JobForm({ jobId, initial }: { jobId?: string; initial?: JobDraft }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const [d, setD] = useState<JobDraft>(initial ?? START);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    const category = d.category === CUSTOM_CATEGORY ? d.customCategory.trim() : d.category;
    if (d.title.trim().length < 4) return setError("Give the job a real title (4+ characters).");
    if (d.description.trim().length < 20) return setError("The brief needs at least 20 characters — describe the work and the acceptance bar.");
    if (category.length < 2) return setError("Pick a category, or type a custom one (2+ characters).");
    if (!(Number(d.budget) > 0)) return setError("Max budget must be a positive ETH amount.");
    setSubmitting(true);
    try {
      const payload = {
        title: d.title.trim(),
        description: d.description.trim(),
        category,
        skills: skillTokens(d.skills).slice(0, 15),
        budget: d.budget,
      };
      if (jobId) {
        await patch(`/jobs/${jobId}`, payload);
        invalidate.job(jobId);
        toast.success("Draft updated", { description: "Freelancers bidding on it see the new ceiling." });
      } else {
        const job = await post<{ id: string }>("/jobs", payload);
        toast.success("Draft saved", { description: "Publish it when the brief reads right." });
        router.push(`/jobs/${job.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass space-y-6 rounded-3xl p-7 md:p-9">
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
          placeholder="Context, scope, acceptance criteria, what the reviewer checks when a milestone lands. Markdown-ish paragraphs work well."
        />
        <p className="text-[12px] text-faint">Minimum 20 characters. This is what proposals will be written against.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Category</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-11 w-full items-center justify-between rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors hover:border-line-strong focus-visible:border-rose-accent/50"
              >
                <span>{d.category === CUSTOM_CATEGORY ? "Custom…" : d.category}</span>
                <CaretDown className="h-4 w-4 shrink-0 text-faint" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="glass-raised w-56 rounded-2xl border-line p-1.5">
              {CATEGORIES.map((c) => (
                <DropdownMenuItem
                  key={c} onSelect={() => setD({ ...d, category: c })}
                  className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm"
                >
                  {c}
                  {d.category === c && <Check className="h-3.5 w-3.5 text-rose-bright" weight="bold" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onSelect={() => setD({ ...d, category: CUSTOM_CATEGORY })}
                className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm text-dim"
              >
                Custom…
                {d.category === CUSTOM_CATEGORY && <Check className="h-3.5 w-3.5 text-rose-bright" weight="bold" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {d.category === CUSTOM_CATEGORY && (
            <Input
              value={d.customCategory} onChange={(e) => setD({ ...d, customCategory: e.target.value })}
              placeholder="e.g. zero-knowledge"
              className="h-11 border-line bg-white/[0.03] text-sm"
            />
          )}
        </div>
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Max budget (ETH)</label>
          <Input value={d.budget} onChange={(e) => setD({ ...d, budget: e.target.value })} className="num h-11 border-line bg-white/[0.03] text-sm" />
          <p className="text-[12px] text-faint">The ceiling on any bid — and what you lock in escrow to publish. You pay the bid you accept; the rest is withdrawable.</p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[13px] font-medium">Skills</label>
        <SkillPicker
          value={d.skills}
          onChange={(skills) => setD({ ...d, skills })}
          onError={setError}
        />
        <p className="text-[12px] text-faint">Up to 15 — presets or your own, comma-free.</p>
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">
          <Warning weight="bold" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <Button
        onClick={submit}
        disabled={submitting}
        className="w-full rounded-full bg-rose-accent py-3.5 text-sm font-medium hover:bg-rose-bright"
      >
        {submitting
          ? "Saving…"
          : jobId
            ? <span className="flex items-center gap-2">Save changes <ArrowRight className="h-4 w-4" weight="bold" /></span>
            : <span className="flex items-center gap-2">Save draft <ArrowRight className="h-4 w-4" weight="bold" /></span>}
      </Button>
      <p className="text-center text-[12px] text-faint">
        Freelancers shape the milestone breakdown themselves — you review the bids. Nothing moves on-chain until you
        lock the budget to publish.
      </p>
    </div>
  );
}

/* ── multi-select skill dropdown (presets + custom) ─────────────────── */

function SkillPicker({ value, onChange, onError }: { value: string; onChange: (v: string) => void; onError: (e: string) => void }) {
  const [custom, setCustom] = useState("");
  const tokens = skillTokens(value);

  function toggle(skill: string) {
    const next = tokens.includes(skill) ? tokens.filter((t) => t !== skill) : [...tokens, skill];
    onChange(next.join(", "));
  }

  function addCustom() {
    const skill = custom.trim().replace(/,/g, "");
    if (!skill) return;
    if (skill.length > 40) return onError("Custom skills cap at 40 characters.");
    if (tokens.length >= 15) return onError("Up to 15 skills — remove one to add another.");
    if (tokens.some((t) => t.toLowerCase() === skill.toLowerCase())) return setCustom("");
    onChange([...tokens, skill].join(", "));
    setCustom("");
  }

  const preview = tokens.slice(0, 3).join(", ") + (tokens.length > 3 ? ` +${tokens.length - 3}` : "");

  return (
    <div className="space-y-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors hover:border-line-strong focus-visible:border-rose-accent/50"
          >
            <span className={`min-w-0 truncate ${tokens.length ? "" : "text-faint"}`}>
              {tokens.length ? preview : "Select skills…"}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {tokens.length > 0 && <span className="num text-[11px] text-faint">{tokens.length}/15</span>}
              <CaretDown className="h-4 w-4 text-faint" />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="glass-raised w-64 rounded-2xl border-line p-1.5">
          {PRESET_SKILLS.map((s) => (
            <DropdownMenuItem
              key={s} onSelect={(e) => { e.preventDefault(); toggle(s); }}
              className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm"
            >
              {s}
              {tokens.includes(s) && <Check className="h-3.5 w-3.5 text-rose-bright" weight="bold" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-white/[0.06]" />
          <div className="flex items-center gap-1.5 p-1">
            <Input
              value={custom} onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
              placeholder="Custom skill…"
              className="h-9 flex-1 border-line bg-white/[0.03] text-[13px]"
            />
            <Button type="button" onClick={addCustom} disabled={!custom.trim()} className="h-9 shrink-0 rounded-xl bg-white/10 px-3.5 text-[13px] hover:bg-white/20">
              Add
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tokens.map((t) => (
            <Chip key={t} className="gap-1.5 py-1 pl-2.5 pr-1.5">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => toggle(t)} className="rounded-full p-0.5 text-faint transition-colors hover:text-foreground">
                <X className="h-3 w-3" weight="bold" />
              </button>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
