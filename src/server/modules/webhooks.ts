/** /webhooks — user-managed webhook subscriptions + delivery log (PRD F9). */
import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { pagination, validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { getQueues } from '../lib/queue'
import { NOTIFICATION_TYPES } from '../domain/notifications'
import type { WebhookEnvelope } from '../domain/notifications'
import { notificationEvents, webhookDeliveries, webhookSubscriptions } from '../db/schema'

export async function listWebhooks(request: Request) {
  const user = await requireAuth(request)
  const db = getDb()
  const subs = await db.select().from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, user.id))
    .orderBy(desc(webhookSubscriptions.createdAt))

  // Attach a compact delivery rollup per subscription (last 30d window is a
  // later concern; for the demo a straight three-way count is enough).
  if (subs.length === 0) return []
  const stats = await db.select({
    subscriptionId: webhookDeliveries.subscriptionId,
    status: webhookDeliveries.status,
    n: count(),
  }).from(webhookDeliveries)
    .where(inArray(webhookDeliveries.subscriptionId, subs.map((s) => s.id)))
    .groupBy(webhookDeliveries.subscriptionId, webhookDeliveries.status)

  const bySub = new Map<string, { pending: number; success: number; failed: number; total: number }>()
  for (const s of subs) bySub.set(s.id, { pending: 0, success: 0, failed: 0, total: 0 })
  for (const r of stats) {
    const bucket = bySub.get(r.subscriptionId)
    if (!bucket) continue
    bucket[r.status] = r.n
    bucket.total += r.n
  }
  return subs.map((s) => ({ ...s, stats: bySub.get(s.id)! }))
}

export async function createWebhook(request: Request) {
  const user = await requireKyc(request)
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
  const user = await requireKyc(request)
  const db = getDb()
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, webhookId)).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  if (sub.userId !== user.id) throw Errors.forbidden('Not your subscription')
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))
  return { deleted: true }
}

/** Rotate the HMAC secret; the new value is returned exactly once. */
export async function rotateSecret(request: Request, webhookId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const sub = await ownedSubscription(user.id, webhookId)
  const secret = randomBytes(24).toString('hex')
  const [updated] = await db.update(webhookSubscriptions).set({ secret })
    .where(eq(webhookSubscriptions.id, sub.id)).returning()
  return { id: updated!.id, secret: updated!.secret }
}

/**
 * Send a synthetic `webhook.test` event to a single subscription immediately.
 * Creates a real event + delivery row (so it appears in the log) and enqueues
 * one attempt — giving the user a way to validate their endpoint end-to-end.
 */
export async function testWebhook(request: Request, webhookId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const sub = await ownedSubscription(user.id, webhookId)

  const envelope: WebhookEnvelope = {
    id: crypto.randomUUID(),
    type: 'webhook.test',
    ts: new Date().toISOString(),
    actor: user.walletAddress,
    projectId: null,
    milestoneId: null,
    payload: { message: 'OpenLance test delivery — your endpoint received a signed ping.', url: sub.url },
  }

  const deliveryId = await db.transaction(async (tx) => {
    const [event] = await tx.insert(notificationEvents).values({
      type: 'webhook.test',
      actorAddress: user.walletAddress,
      payload: envelope.payload,
    }).returning({ id: notificationEvents.id })
    const [delivery] = await tx.insert(webhookDeliveries).values({
      subscriptionId: sub.id,
      eventId: event!.id,
      envelope,
      status: 'pending',
    }).returning({ id: webhookDeliveries.id })
    return delivery!.id
  })

  const queues = await getQueues()
  await queues.enqueueWebhookDelivery(deliveryId)
  return { deliveryId, url: sub.url }
}

/** Re-enqueue a terminal delivery for another attempt (resets the backoff). */
export async function redeliver(request: Request, webhookId: string, deliveryId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const sub = await ownedSubscription(user.id, webhookId)
  const [delivery] = await db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.subscriptionId, sub.id))).limit(1)
  if (!delivery) throw Errors.notFound('Delivery')
  if (delivery.status === 'pending') throw Errors.conflict('delivery_pending', 'Delivery is already queued')

  await db.update(webhookDeliveries).set({
    status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, deliveredAt: null,
  }).where(eq(webhookDeliveries.id, delivery.id))

  const queues = await getQueues()
  await queues.enqueueWebhookDelivery(delivery.id)
  return { redelivered: true, deliveryId: delivery.id }
}

export async function listDeliveries(request: Request, webhookId: string) {
  const user = await requireAuth(request)
  const { limit, offset } = pagination(new URL(request.url), 25, 100)
  const db = getDb()
  const sub = await ownedSubscription(user.id, webhookId)
  const [items, totalRows] = await Promise.all([
    db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, sub.id))
      .orderBy(desc(webhookDeliveries.createdAt)).limit(limit).offset(offset),
    db.select({ n: count() }).from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, sub.id)),
  ])
  return { items, total: totalRows[0]?.n ?? 0 }
}

/** Load a subscription the caller owns, or throw notFound/forbidden. */
async function ownedSubscription(userId: string, webhookId: string) {
  const db = getDb()
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, webhookId)).limit(1)
  if (!sub) throw Errors.notFound('Webhook subscription')
  if (sub.userId !== userId) throw Errors.forbidden('Not your subscription')
  return sub
}
