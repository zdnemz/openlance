/** /webhooks — user-managed webhook subscriptions + delivery log (PRD F9). */
import { randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { pagination, validate } from '../lib/http'
import { requireAuth } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { NOTIFICATION_TYPES } from '../domain/notifications'
import { webhookDeliveries, webhookSubscriptions } from '../db/schema'

export async function listWebhooks(request: Request) {
  const user = await requireAuth(request)
  const db = getDb()
  return db.select().from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, user.id))
    .orderBy(desc(webhookSubscriptions.createdAt))
}

export async function createWebhook(request: Request) {
  const user = await requireAuth(request)
  const body = await validate(request, z.object({
    url: z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'http(s) URL required'),
    eventTypes: z.array(z.enum(NOTIFICATION_TYPES)).max(20).default([]), // empty = all events
  }).strict())
  const secret = randomBytes(24).toString('hex')
  const db = getDb()
  const [sub] = await db.insert(webhookSubscriptions).values({
    userId: user.id,
    url: body.url,
    secret,
    eventTypes: body.eventTypes,
  }).returning()
  return sub
}

export async function deleteWebhook(request: Request, webhookId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, webhookId)).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  if (sub.userId !== user.id) throw Errors.forbidden('Not your subscription')
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))
  return { deleted: true }
}

export async function listDeliveries(request: Request, webhookId: string) {
  const user = await requireAuth(request)
  const { limit, offset } = pagination(new URL(request.url), 25, 100)
  const db = getDb()
  const [sub] = await db.select().from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, webhookId), eq(webhookSubscriptions.userId, user.id))).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  return db.select().from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, sub.id))
    .orderBy(desc(webhookDeliveries.createdAt)).limit(limit).offset(offset)
}
