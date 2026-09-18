/** /webhooks — user-managed webhook subscriptions + delivery log (PRD F9). */
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, validate, pagination } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { NOTIFICATION_TYPES } from '../domain/notifications'
import { webhookDeliveries, webhookSubscriptions } from '../db/schema'

export const webhookRoutes = new Hono()

webhookRoutes.get('/', readLimiter(), requireAuth, async (c) => {
  const db = await getDb()
  const rows = await db.select().from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, getUser(c).id))
    .orderBy(desc(webhookSubscriptions.createdAt))
  return ok(c, rows)
})

webhookRoutes.post('/', writeLimiter(), requireAuth, async (c) => {
  const body = await validate(c, z.object({
    url: z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'http(s) URL required'),
    eventTypes: z.array(z.enum(NOTIFICATION_TYPES)).max(20).default([]), // empty = all events
  }).strict())
  const secret = randomBytes(24).toString('hex')
  const db = await getDb()
  const [sub] = await db.insert(webhookSubscriptions).values({
    userId: getUser(c).id,
    url: body.url,
    secret,
    eventTypes: body.eventTypes,
  }).returning()
  return ok(c, sub, 201)
})

webhookRoutes.delete('/:id', writeLimiter(), requireAuth, async (c) => {
  const db = await getDb()
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, c.req.param('id'))).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  if (sub.userId !== getUser(c).id) throw Errors.forbidden('Not your subscription')
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))
  return ok(c, { deleted: true })
})

webhookRoutes.get('/:id/deliveries', readLimiter(), requireAuth, async (c) => {
  const { limit, offset } = pagination(c, 25, 100)
  const db = await getDb()
  const [sub] = await db.select().from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, c.req.param('id')), eq(webhookSubscriptions.userId, getUser(c).id))).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  const rows = await db.select().from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, sub.id))
    .orderBy(desc(webhookDeliveries.createdAt)).limit(limit).offset(offset)
  return ok(c, rows)
})
