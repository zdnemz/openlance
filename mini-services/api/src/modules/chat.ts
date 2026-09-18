/**
 * /projects/:id/messages — realtime room per project (PRD F6).
 *
 * Messages are append-only evidence: the API rejects edits/deletes at every
 * layer (no UPDATE/DELETE route, RLS denies it on Supabase, no updated_at
 * column exists). Realtime fan-out happens through Supabase Realtime
 * (postgres_changes on `messages`) in Supabase deployments; the REST
 * endpoint remains the write path and the polling fallback everywhere else.
 */
import { Hono } from 'hono'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { attachments, messages } from '../db/schema'
import { requireParticipant } from './helpers'

export const chatRoutes = new Hono()

chatRoutes.get('/:id/messages', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
  const before = c.req.query('before') // message id for cursor pagination
  const db = await getDb()

  const rows = await db.transaction(async (tx) => {
    let cursorDate: Date | null = null
    if (before) {
      const [b] = await tx.select({ createdAt: messages.createdAt }).from(messages).where(eq(messages.id, before)).limit(1)
      if (b) cursorDate = b.createdAt
    }
    const where = cursorDate
      ? and(eq(messages.projectId, project.id), lt(messages.createdAt, cursorDate))
      : eq(messages.projectId, project.id)
    return tx.select().from(messages).where(where).orderBy(desc(messages.createdAt)).limit(limit)
  })
  return ok(c, rows.reverse()) // oldest → newest for display
})

chatRoutes.post('/:id/messages', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const body = await validate(c, z.object({
    body: z.string().min(1).max(8000),
    attachmentId: z.string().uuid().optional(),
  }).strict())

  const db = await getDb()
  if (body.attachmentId) {
    const [att] = await db.select().from(attachments).where(eq(attachments.id, body.attachmentId)).limit(1)
    if (!att || att.projectId !== project.id) throw Errors.badRequest('attachment_unknown', 'Attachment not found in this project')
    if (att.uploaderId !== user.id) throw Errors.forbidden('Attachment belongs to another participant')
    if (att.status !== 'confirmed') throw Errors.badRequest('attachment_not_uploaded', 'Attachment has not been uploaded yet')
  }

  const [message] = await db.insert(messages).values({
    projectId: project.id,
    senderId: user.id,
    body: body.body,
    attachmentId: body.attachmentId ?? null,
  }).returning()
  return ok(c, message, 201)
})
