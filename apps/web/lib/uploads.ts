"use client";

/**
 * Attachment upload — init → upload bytes → confirm.
 *
 * The API hands back the upload target on init (a signed Supabase URL, or this
 * API's own `PUT /api/files/:id/raw` under the local driver), so the browser
 * never guesses a storage path. Confirm is a HEAD from the server: it is what
 * makes the row visible to readers, so it must land or the file does not exist.
 */
import { post, putBytes, fileUrl } from "@/lib/api";

export interface InitResult {
  attachmentId: string;
  driver: "supabase" | "local";
  bucket?: string;
  path: string;
  token?: string;
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
}

/** Upload one file against an already-created owner (project or proposal). */
export async function uploadAttachment(ownerPath: string, file: File): Promise<UploadedFile> {
  const init = await post<InitResult>(`${ownerPath}/attachments`, {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });

  if (init.driver === "supabase") {
    const res = await fetch(init.uploadUrl, {
      method: "POST",
      headers: init.token ? { "x-upsert": "true", Authorization: `Bearer ${init.token}`, "Content-Type": "application/octet-stream" } : {},
      body: file,
    });
    if (!res.ok) throw new Error(`Upload of ${file.name} failed (${res.status})`);
  } else {
    await putBytes(fileUrl(init.uploadUrl), file, init.headers?.["Content-Type"] ?? (file.type || "application/octet-stream"));
  }

  return post<UploadedFile>(`/attachments/${init.attachmentId}/confirm`);
}
