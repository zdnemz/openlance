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
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { get, fileUrl } from "@/lib/api";

export function AttachmentChip({ attachment }: { attachment: { id: string; filename: string; sizeBytes: number } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await get<{ url: string }>(`/attachments/${attachment.id}/url`);
      window.open(fileUrl(url), "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open the file");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      title={err ?? attachment.filename}
      className="inline-flex max-w-[15rem] items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[11.5px] text-dim transition-colors hover:border-line-strong hover:text-foreground disabled:opacity-50"
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0 text-faint" weight="bold" />
      <span className="truncate">{attachment.filename}</span>
      <span className="num shrink-0 text-faint">{formatBytes(attachment.sizeBytes)}</span>
    </button>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
