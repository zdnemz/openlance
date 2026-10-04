"use client";

/**
 * A single stored file, rendered as a chip the reader clicks to open.
 *
 * The URL is never stored on the row: the API mints a short-lived signed URL on
 * GET `/attachments/:id/url` (one round-trip, bytes never touch a public path),
 * so the chip asks for it at click time. That is why this is a component and not
 * a plain <a> — both the bid view and the project room open files the same way.
 */
import { useState } from "react";
import { Paperclip } from "@/components/icons";
import { get, fileUrl } from "@/lib/api";

export function AttachmentChip({ attachment }: { attachment: { id: string; filename: string; sizeBytes: number } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await get<{ url: string }>(`/attachments/${attachment.id}/url`);
      // `window.open` runs AFTER the await, so it is outside the click's
      // transient user-activation window and a slow round-trip gets the popup
      // blocked. Nothing was checked, so the click looked like a no-op and the
      // reason was only ever a `title` — invisible on touch, silent for AT.
      const win = window.open(fileUrl(url), "_blank", "noopener");
      if (!win) setErr("Your browser blocked the new tab — allow popups for this site.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open the file");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex max-w-[15rem] items-center gap-2 border border-line bg-white/[0.03] px-3 py-1.5 text-[11.5px] text-dim">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground disabled:opacity-50"
      >
        <Paperclip className="h-3.5 w-3.5 shrink-0 text-faint" weight="bold" />
        <span className="truncate">{attachment.filename}</span>
        <span className="num shrink-0 text-faint">{formatBytes(attachment.sizeBytes)}</span>
      </button>
      {/* role="alert" + visible text: a native `title` is the one place an error
          can hide completely — no touch, no screen reader, no visual. */}
      {err && <span role="alert" className="shrink-0 text-[11px] text-destructive">{err}</span>}
    </span>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
