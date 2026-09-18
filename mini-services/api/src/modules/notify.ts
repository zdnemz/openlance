/**
 * Notification outbox (PRD F9). One row per domain event; webhook delivery is
 * a separate, retryable concern. Shared by API routes and the chain indexer.
 */
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../lib/db'
import { getQueues } from '../lib/queue'
import type { NotificationType, WebhookEnvelope } from '../domain/notifications'
import { notificationEvents, webhookDeliveries, webhookSubscriptions } from '../db/schema'

export interface NotifyInput {
  type: NotificationType
  actorAddress?: string | null
  projectId?: string | null
  milestoneId?: string | null
  payload?: Record<string, unknown>
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Insert event + pending deliveries inside a caller-owned transaction. Returns delivery ids. */
export async function writeOutbox(tx: Tx, n: NotifyInput): Promise<string[]> {
  const [event] = await tx.insert(notificationEvents).values({
    type: n.type,
    actorAddress: n.actorAddress?.toLowerCase() ?? null,
    projectId: n.projectId ?? null,
    milestoneId: n.milestoneId ?? null,
    payload: n.payload ?? {},
  }).returning({ id: notificationEvents.id })
  if (!event) return []

  const subs = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true))
  const matching = subs.filter((s) => s.eventTypes.length === 0 || s.eventTypes.includes(n.type))
  if (matching.length === 0) return []

  const envelope: WebhookEnvelope = {
    id: event.id, type: n.type, ts: new Date().toISOString(),
    actor: n.actorAddress?.toLowerCase() ?? null,
    projectId: n.projectId ?? null, milestoneId: n.milestoneId ?? null,
    payload: n.payload ?? {},
  }
  const rows = await tx.insert(webhookDeliveries).values(
    matching.map((s) => ({
      subscriptionId: s.id, eventId: event.id, envelope, status: 'pending' as const,
    })),
  ).returning({ id: webhookDeliveries.id })
  return rows.map((r) => r.id)
}

/** Standalone emission for API routes: outbox in one tx, enqueue after commit. */
export async function emitNotification(n: NotifyInput): Promise<void> {
  const deliveryIds = await (await getDb()).transaction(async (tx) => writeOutbox(tx, n))
  if (deliveryIds.length) {
    const queues = await getQueues()
    await Promise.all(deliveryIds.map((id) => queues.enqueueWebhookDelivery(id)))
  }
}
