/**
 * /projects/:id/messages — realtime room per project (PRD F6).
 *
 * Messages are append-only evidence: the API rejects edits/deletes at every
 * layer. Realtime fan-out happens through Supabase Realtime in Supabase
 * deployments; the REST endpoint remains the write path elsewhere.
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { attachments, messages } from '../db/schema'
import { requireParticipant } from './helpers'

export async function listMessages(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
  const before = url.searchParams.get('before') // message id for cursor pagination
  const db = getDb()

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
  return rows.reverse() // oldest → newest for display
}

export async function createMessage(request: Request, projectId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  const body = await validate(request, z.object({
    body: z.string().min(1).max(8000),
    attachmentId: z.string().uuid().optional(),
  }).strict())

  const db = getDb()
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
  return message
}
