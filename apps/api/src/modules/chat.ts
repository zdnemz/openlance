/**
 * /projects/:id/messages — realtime room per project (PRD F6).
 *
 * Messages are append-only evidence: the API rejects edits/deletes at every
 * layer. Realtime fan-out happens through Supabase Realtime in Supabase
 * deployments; the REST endpoint remains the write path elsewhere.
 *
 * Read state is a per-viewer cursor in `message_read_cursors`, not a column on
 * `messages` — reading must never mutate a row of the evidence log.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { requireAuth, requireKyc } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { attachments, messageReadCursors, messages } from '../db/schema.ts'
import { requireParticipant, requireParticipantOrArbiter } from './helpers.ts'

/**
 * The two participants of a project room. `requireParticipant` has already
 * proven `user` is one of them, so the other one is whichever id is not theirs.
 */
function counterpartyOf(project: { clientId: string; freelancerId: string }, userId: string): string {
  return project.clientId === userId ? project.freelancerId : project.clientId
}

export async function listMessages(request: Request, projectId: string) {
  const user = await requireAuth(request)
  // Read-only for seated arbiters: the conversation is dispute evidence.
  const project = await requireParticipantOrArbiter(projectId, user)
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
  const ordered = rows.reverse() // oldest → newest for display

  // One indexed row read tells us which of my messages the other side has seen.
  // `<=`: the client posts the timestamp of the newest message it actually
  // rendered, so that message is read. The only over-claim is a second insert
  // landing on the identical microsecond, which distinct inserts never do.
  const [cursor] = await db.select({ readThrough: messageReadCursors.readThrough })
    .from(messageReadCursors)
    .where(and(
      eq(messageReadCursors.projectId, project.id),
      eq(messageReadCursors.userId, counterpartyOf(project, user.id)),
    ))
    .limit(1)
  const readThrough = cursor?.readThrough ?? null

  return ordered.map((m) => ({
    ...m,
    readByOther: readThrough !== null && m.senderId === user.id && m.createdAt <= readThrough,
  }))
}

/**
 * Move this viewer's read watermark forward. `through` defaults to now: the
 * client posts the newest message it actually rendered, so a message that
 * arrives mid-request is not silently marked as seen.
 *
 * Monotonic — GREATEST, never a backwards move — because an out-of-order
 * request must not un-read the room. Future timestamps are rejected rather
 * than clamped: a client claiming to have read messages that cannot exist yet
 * is a bug or a lie, and neither deserves a stored cursor.
 */
export async function markMessagesRead(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const body = await validate(request, z.object({
    through: z.string().datetime({ offset: true }).optional(),
  }).strict())

  const now = new Date()
  let through = now
  if (body.through) {
    const claimed = new Date(body.through)
    if (Number.isNaN(claimed.getTime())) throw Errors.badRequest('read_through_invalid', 'read_through is not a valid timestamp')
    if (claimed.getTime() > now.getTime() + 1000) {
      throw Errors.badRequest('read_through_future', 'read_through cannot be in the future')
    }
    through = claimed
  }

  const [row] = await getDb().insert(messageReadCursors)
    .values({ projectId: project.id, userId: user.id, readThrough: through })
    .onConflictDoUpdate({
      target: [messageReadCursors.projectId, messageReadCursors.userId],
      // Interpolated as an ISO string with an explicit cast: a raw `Date` in a
      // sql`` fragment comes through untyped and the driver encodes it as text.
      set: { readThrough: sql`GREATEST(${messageReadCursors.readThrough}, ${through.toISOString()}::timestamptz)` },
    })
    .returning()
  return { readThrough: row!.readThrough }
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
