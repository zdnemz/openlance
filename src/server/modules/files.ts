/**
 * /attachments + /files — project file storage (PRD F7).
 *
 * Flow: init (metadata + upload target) → client uploads → confirm (HEAD).
 * Drivers: Supabase Storage signed URLs (production) or local disk with
 * HMAC-signed download URLs (zero-infra dev).
 */
import { createHmac } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { attachments } from '../db/schema'
import { requireParticipant } from './helpers'
import { isMimeAllowed, storageConfig, storageKey, supabaseAdmin } from '../storage'

// ── Supabase Storage driver ─────────────────────────────────────────────────
async function supabaseUploadUrl(path: string): Promise<{ url: string; token: string; path: string }> {
  const sb = await supabaseAdmin()
  const { data, error } = await sb.storage.from(env.STORAGE_BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw Errors.internal(`Storage error: ${error?.message ?? 'no signed url'}`)
  return { url: data.signedUrl, token: data.token, path: data.path }
}

async function supabaseDownloadUrl(path: string, ttl: number): Promise<string> {
  const sb = await supabaseAdmin()
  const { data, error } = await sb.storage.from(env.STORAGE_BUCKET).createSignedUrl(path, ttl)
  if (error || !data) throw Errors.internal(`Storage error: ${error?.message ?? 'no signed url'}`)
  return data.signedUrl
}

async function supabaseExists(path: string): Promise<boolean> {
  const sb = await supabaseAdmin()
  const dir = dirname(path)
  const base = path.split('/').pop()!
  const { data } = await sb.storage.from(env.STORAGE_BUCKET).list(dir, { search: base, limit: 1 })
  return Array.isArray(data) && data.length > 0
}

// ── Local disk driver (HMAC-signed URLs through this API) ──────────────────
const hmac = (payload: string) => createHmac('sha256', env.SUPABASE_JWT_SECRET).update(payload).digest('base64url')

function localPath(storagePath: string) {
  return join(storageConfig().localDir, storagePath)
}

function signedLocalUrl(attachmentId: string): string {
  const exp = Date.now() + storageConfig().signedUrlTtlSeconds * 1000
  const sig = hmac(`${attachmentId}.${exp}`)
  return `${env.API_URI}/api/files/${attachmentId}/raw?exp=${exp}&sig=${encodeURIComponent(sig)}`
}

// ── Handlers ──────────────────────────────────────────────────────────────────
export async function initAttachment(request: Request, projectId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  const body = await validate(request, z.object({
    filename: z.string().min(1).max(200).regex(/^[\w\-. ()]+$/, 'Filename contains forbidden characters'),
    mimeType: z.string().min(3).max(100),
    sizeBytes: z.number().int().min(1).max(storageConfig().maxUploadBytes),
  }).strict())

  if (!isMimeAllowed(body.mimeType)) {
    throw Errors.badRequest('mime_not_allowed', `MIME type not allowed: ${body.mimeType}. Allowed: pdf, images, zip, docs, text/code files.`)
  }

  const cfg = storageConfig()
  const db = getDb()
  const [att] = await db.insert(attachments).values({
    projectId: project.id,
    uploaderId: user.id,
    filename: body.filename,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    storageDriver: cfg.driver,
    storagePath: '', // set below
  }).returning()

  const storagePath = storageKey(`${project.id}/${att!.id}/${body.filename}`)
  await db.update(attachments).set({ storagePath }).where(eq(attachments.id, att!.id))

  if (cfg.driver === 'supabase') {
    const target = await supabaseUploadUrl(storagePath)
    return {
      attachmentId: att!.id, driver: 'supabase', bucket: cfg.bucket,
      path: target.path, token: target.token, uploadUrl: target.url,
      note: 'POST the file to uploadUrl (or use supabase-js uploadToSignedUrl)',
    }
  }
  return {
    attachmentId: att!.id, driver: 'local', path: storagePath,
    uploadUrl: `${env.API_URI}/api/files/${att!.id}/raw`,
    method: 'PUT', headers: { 'Content-Type': body.mimeType },
    note: 'PUT the raw bytes to uploadUrl with your Bearer token',
  }
}

/** Confirm the upload landed (HEAD via driver). */
export async function confirmAttachment(request: Request, attachmentId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  if (att.uploaderId !== user.id) throw Errors.forbidden('Not your attachment')
  if (att.status === 'confirmed') return att

  const exists = storageConfig().driver === 'supabase'
    ? await supabaseExists(att.storagePath)
    : await stat(localPath(att.storagePath)).then(() => true).catch(() => false)
  if (!exists) throw Errors.badRequest('upload_missing', 'No bytes found at the storage path — upload first')

  const [updated] = await db.update(attachments).set({ status: 'confirmed' })
    .where(eq(attachments.id, att.id)).returning()
  return updated
}

/** Participant-checked download URL. */
export async function attachmentUrl(request: Request, attachmentId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  await requireParticipant(att.projectId, user)
  if (att.status !== 'confirmed') throw Errors.badRequest('upload_missing', 'Attachment not uploaded yet')
  const cfg = storageConfig()
  const url = cfg.driver === 'supabase'
    ? await supabaseDownloadUrl(att.storagePath, cfg.signedUrlTtlSeconds)
    : signedLocalUrl(att.id)
  return { url, expiresInSeconds: cfg.signedUrlTtlSeconds, filename: att.filename, mimeType: att.mimeType, sizeBytes: att.sizeBytes }
}

/** Local-driver upload (Bearer auth, size-capped). */
export async function putAttachmentRaw(request: Request, attachmentId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  if (att.uploaderId !== user.id) throw Errors.forbidden('Not your attachment')
  if (storageConfig().driver === 'supabase') throw Errors.badRequest('local_driver_only', 'This route exists only in local storage mode')
  const buf = await request.arrayBuffer()
  if (buf.byteLength > storageConfig().maxUploadBytes) throw Errors.badRequest('too_large', 'File exceeds size limit')
  if (buf.byteLength === 0) throw Errors.badRequest('empty_upload', 'No bytes received')
  const dest = localPath(att.storagePath)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(buf))
  return { stored: true, bytes: buf.byteLength }
}

/** Local-driver signed download (no auth header needed). */
export async function getAttachmentRaw(attachmentId: string, url: URL): Promise<Response> {
  const db = getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  // verify HMAC signature
  const exp = Number(url.searchParams.get('exp') ?? 0)
  const sig = url.searchParams.get('sig') ?? ''
  if (!exp || Date.now() > exp || hmac(`${attachmentId}.${exp}`) !== sig) {
    throw Errors.unauthorized('Invalid or expired download signature')
  }
  if (storageConfig().driver === 'supabase') throw Errors.badRequest('local_driver_only', 'This route exists only in local storage mode')
  const path = localPath(att.storagePath)
  const exists = await stat(path).then(() => true).catch(() => false)
  if (!exists) throw Errors.notFound('File bytes')
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(path)
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': att.mimeType, 'Content-Disposition': `attachment; filename="${att.filename}"` },
  })
}
