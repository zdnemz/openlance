"use client";

/**
 * Evidence picker: a multi-file input with removable chips and a live `n/max`
 * counter.
 *
 * Shared by the propose form and the delivery record so the two cannot drift.
 * `max` comes from the server's storage config (runtime `storage.maxAttachments`)
 * — this component is the visible counter, the API is the invariant, and the two
 * read the same number so a client cannot walk around the limit and then be
 * surprised by a 400.
 */
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { X } from "@phosphor-icons/react/dist/csr/X";

export function AttachmentPicker({
  files,
  onChange,
  max,
  label = "Evidence",
  hint = "The client sees these when they open the file.",
  emptyLabel = "Attach a portfolio piece, past audit, or spec",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  max: number;
  label?: string;
  hint?: string;
  emptyLabel?: string;
}) {
  const full = files.length >= max;
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium">
        {label} <span className="num text-faint">({files.length}/{max})</span>
      </label>
      <label
        className={`flex items-center gap-2.5 rounded-2xl border border-dashed px-4 py-3.5 text-[13px] transition-colors ${
          full
            ? "cursor-not-allowed border-line/50 text-faint"
            : "cursor-pointer border-line text-dim hover:border-line-strong hover:text-foreground"
        }`}
      >
        <Paperclip className="h-4 w-4 shrink-0 text-faint" weight="bold" />
        {full ? "Limit reached — remove one to add another" : files.length ? "Add another file" : emptyLabel}
        <input
          type="file"
          multiple
          className="sr-only"
          disabled={full}
          onChange={(e) => {
            // Trim to the ceiling rather than rejecting: the chips already show
            // what is attached, so dropping the overflow is the predictable move.
            onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, max));
            e.target.value = "";
          }}
        />
      </label>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex max-w-[14rem] items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[11.5px] text-dim"
            >
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="text-faint hover:text-destructive"
              >
                <X className="h-3 w-3" weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-faint">{hint}</p>
    </div>
  );
}
