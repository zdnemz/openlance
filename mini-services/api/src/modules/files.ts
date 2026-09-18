/**
 * /attachments + /files — project file storage (PRD F7).
 *
 * Flow: init (metadata + upload target) → client uploads → confirm (HEAD).
 * Drivers: Supabase Storage signed URLs (production) or local disk with
 * HMAC-signed download URLs (zero-infra dev). Limits: 25MB + mime allowlist.
 * Access is always participant-checked by the API — the bucket itself is
 * service-role only, so no object is reachable without going through us.
 */
import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { attachments } from '../db/schema'
import { requireParticipant } from './helpers'

export const fileRoutes = new Hono()

/** Allowlist (PRD F7): pdf / images / zip / docs / code. */
const MIME_ALLOWLIST = new Set([
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'text/x-typescript', 'text/javascript', 'application/typescript',
  'text/x-python', 'text/x-rust', 'text/x-go', 'text/x-sol', 'text/x-sql',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

// ── Supabase Storage driver ─────────────────────────────────────────────────
async function supabaseClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function supabaseUploadUrl(path: string): Promise<{ url: string; token: string; path: string }> {
  const sb = await supabaseClient()
  const { data, error } = await sb.storage.from(env.STORAGE_BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw Errors.internal(`Storage error: ${error?.message ?? 'no signed url'}`)
  return { url: data.signedUrl, token: data.token, path: data.path }
}

async function supabaseDownloadUrl(path: string, ttl: number): Promise<string> {
  const sb = await supabaseClient()
  const { data, error } = await sb.storage.from(env.STORAGE_BUCKET).createSignedUrl(path, ttl)
  if (error || !data) throw Errors.internal(`Storage error: ${error?.message ?? 'no signed url'}`)
  return data.signedUrl
}

async function supabaseExists(path: string): Promise<boolean> {
  const sb = await supabaseClient()
  const dir = dirname(path)
  const base = path.split('/').pop()!
  const { data } = await sb.storage.from(env.STORAGE_BUCKET).list(dir, { search: base, limit: 1 })
  return Array.isArray(data) && data.length > 0
}

// ── Local disk driver (HMAC-signed URLs through this API) ──────────────────
const hmac = (payload: string) => createHmac('sha256', env.SUPABASE_JWT_SECRET).update(payload).digest('base64url')

function localPath(storagePath: string) {
  return join(env.STORAGE_LOCAL_DIR, storagePath)
}

function signedLocalUrl(attachmentId: string): string {
  const exp = Date.now() + env.SIGNED_URL_TTL_SECONDS * 1000
  const sig = hmac(`${attachmentId}.${exp}`)
  return `${env.API_URI}/files/${attachmentId}/raw?exp=${exp}&sig=${encodeURIComponent(sig)}`
}

// ── Routes ──────────────────────────────────────────────────────────────────
fileRoutes.post('/:id/attachments', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const body = await validate(c, z.object({
    filename: z.string().min(1).max(200).regex(/^[\w\-. ()]+$/, 'Filename contains forbidden characters'),
    mimeType: z.string().min(3).max(100),
    sizeBytes: z.number().int().min(1).max(env.MAX_UPLOAD_BYTES),
  }).strict())

  if (!MIME_ALLOWLIST.has(body.mimeType)) {
    throw Errors.badRequest('mime_not_allowed', `MIME type not allowed: ${body.mimeType}. Allowed: pdf, images, zip, docs, text/code files.`)
  }

  const db = await getDb()
  const [att] = await db.insert(attachments).values({
    projectId: project.id,
    uploaderId: user.id,
    filename: body.filename,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    storageDriver: env.storageDriver,
    storagePath: '', // set below
  }).returning()

  const storagePath = `${project.id}/${att!.id}/${body.filename}`
  await db.update(attachments).set({ storagePath }).where(eq(attachments.id, att!.id))

  if (env.storageDriver === 'supabase') {
    const target = await supabaseUploadUrl(storagePath)
    return ok(c, {
      attachmentId: att!.id, driver: 'supabase', bucket: env.STORAGE_BUCKET,
      path: target.path, token: target.token, uploadUrl: target.url,
      note: 'POST the file to uploadUrl (or use supabase-js uploadToSignedUrl)',
    }, 201)
  }
  return ok(c, {
    attachmentId: att!.id, driver: 'local', path: storagePath,
    uploadUrl: `${env.API_URI}/files/${att!.id}/raw`,
    method: 'PUT', headers: { 'Content-Type': body.mimeType },
    note: 'PUT the raw bytes to uploadUrl with your Bearer token',
  }, 201)
})

/** Confirm the upload landed (HEAD via driver). */
fileRoutes.post('/:attachmentId/confirm', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const db = await getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, c.req.param('attachmentId'))).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  if (att.uploaderId !== user.id) throw Errors.forbidden('Not your attachment')
  if (att.status === 'confirmed') return ok(c, att)

  const exists = env.storageDriver === 'supabase'
    ? await supabaseExists(att.storagePath)
    : await stat(localPath(att.storagePath)).then(() => true).catch(() => false)
  if (!exists) throw Errors.badRequest('upload_missing', 'No bytes found at the storage path — upload first')

  const [updated] = await db.update(attachments).set({ status: 'confirmed' })
    .where(eq(attachments.id, att.id)).returning()
  return ok(c, updated)
})

/** Participant-checked download URL. */
fileRoutes.get('/:attachmentId/url', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const db = await getDb()
  const [att] = await db.select().from(attachments).where(eq(attachments.id, c.req.param('attachmentId'))).limit(1)
  if (!att) throw Errors.notFound('Attachment')
  const project = await requireParticipant(att.projectId, user)
  void project
  if (att.status !== 'confirmed') throw Errors.badRequest('upload_missing', 'Attachment not uploaded yet')
  const url = env.storageDriver === 'supabase'
    ? await supabaseDownloadUrl(att.storagePath, env.SIGNED_URL_TTL_SECONDS)
    : signedLocalUrl(att.id)
  return ok(c, { url, expiresInSeconds: env.SIGNED_URL_TTL_SECONDS, filename: att.filename, mimeType: att.mimeType, sizeBytes: att.sizeBytes })
})

/**
 * Local-driver byte endpoints:
 *  PUT  /files/:id/raw        — upload (Bearer auth, size-capped)
 *  GET  /files/:id/raw?exp&sig — signed download (no auth header needed)
 */
fileRoutes.on(['PUT', 'GET'], '/:attachmentId/raw', async (c) => {
  const db = await getDb()
  const id = c.req.param('attachmentId')
  const [att] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1)
  if (!att) throw Errors.notFound('Attachment')

  if (c.req.method === 'PUT') {
    const user = getUser(c)
    if (att.uploaderId !== user.id) throw Errors.forbidden('Not your attachment')
    if (env.storageDriver === 'supabase') throw Errors.badRequest('local_driver_only', 'This route exists only in local storage mode')
    const buf = await c.req.arrayBuffer()
    if (buf.byteLength > env.MAX_UPLOAD_BYTES) throw Errors.badRequest('too_large', 'File exceeds size limit')
    if (buf.byteLength === 0) throw Errors.badRequest('empty_upload', 'No bytes received')
    const dest = localPath(att.storagePath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, Buffer.from(buf))
    return ok(c, { stored: true, bytes: buf.byteLength })
  }

  // GET — verify HMAC signature
  const exp = Number(c.req.query('exp') ?? 0)
  const sig = c.req.query('sig') ?? ''
  if (!exp || Date.now() > exp || hmac(`${id}.${exp}`) !== sig) {
    throw Errors.unauthorized('Invalid or expired download signature')
  }
  if (env.storageDriver === 'supabase') throw Errors.badRequest('local_driver_only', 'This route exists only in local storage mode')
  const path = localPath(att.storagePath)
  const exists = await stat(path).then(() => true).catch(() => false)
  if (!exists) throw Errors.notFound('File bytes')
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(path)
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': att.mimeType, 'Content-Disposition': `attachment; filename="${att.filename}"` },
  })
})

