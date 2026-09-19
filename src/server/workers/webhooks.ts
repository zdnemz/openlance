/**
 * Webhook delivery executor — ONE attempt per call (PRD F9).
 * Retry policy lives in the queue layer (BullMQ backoff or inline setTimeout).
 * Signatures: X-EscrowLance-Signature: sha256=<hmac of body>.
 */
import { eq } from 'drizzle-orm'
import { env } from '../config'
import { getDb } from '../db'
import { logger } from '../lib/logger'
import { isSuccessfulStatus, retryDelayMs, shouldRetry, signPayload } from '../domain/webhooks'
import { webhookDeliveries, webhookSubscriptions } from '../db/schema'
import type { DeliveryOutcome } from '../lib/queue'

const log = logger.child({ component: 'webhooks' })

export async function attemptDelivery(deliveryId: string): Promise<DeliveryOutcome> {
  const db = getDb()
  const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1)
  if (!delivery) return { done: true } // vanished (subscription deleted) — nothing to do
  if (delivery.status !== 'pending') return { done: true }

  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, delivery.subscriptionId)).limit(1)
  if (!sub || !sub.active) {
    await db.update(webhookDeliveries).set({ status: 'failed', lastError: 'subscription gone' })
      .where(eq(webhookDeliveries.id, deliveryId))
    return { done: true }
  }

  const body = JSON.stringify(delivery.envelope)
  const signature = signPayload(body, sub.secret)
  const attempts = delivery.attempts + 1

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), env.WEBHOOK_TIMEOUT_MS)
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EscrowLance-Signature': `sha256=${signature}`,
        'X-EscrowLance-Event': String((delivery.envelope as { type?: string }).type ?? ''),
        'User-Agent': 'EscrowLance-Webhooks/1.0',
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (isSuccessfulStatus(res.status)) {
      await db.update(webhookDeliveries).set({
        status: 'success', attempts, lastStatusCode: res.status, deliveredAt: new Date(), nextAttemptAt: null,
      }).where(eq(webhookDeliveries.id, deliveryId))
      log.info('delivered', { deliveryId, url: sub.url, status: res.status, attempt: attempts })
      return { done: true }
    }

    // non-2xx → retryable
    const willRetry = shouldRetry(attempts, env.WEBHOOK_MAX_ATTEMPTS)
    await db.update(webhookDeliveries).set({
      attempts, lastStatusCode: res.status, status: willRetry ? 'pending' : 'failed',
      nextAttemptAt: willRetry ? new Date(Date.now() + retryDelayMs(attempts)) : null,
      lastError: `HTTP ${res.status}`,
    }).where(eq(webhookDeliveries.id, deliveryId))
    log.warn('delivery failed (HTTP)', { deliveryId, status: res.status, attempt: attempts, willRetry })
    return { done: !willRetry, retryInMs: willRetry ? retryDelayMs(attempts) : undefined }
  } catch (err) {
    const willRetry = shouldRetry(attempts, env.WEBHOOK_MAX_ATTEMPTS)
    const reason = err instanceof Error ? err.message : String(err)
    await db.update(webhookDeliveries).set({
      attempts, status: willRetry ? 'pending' : 'failed',
      nextAttemptAt: willRetry ? new Date(Date.now() + retryDelayMs(attempts)) : null,
      lastError: reason,
    }).where(eq(webhookDeliveries.id, deliveryId))
    log.warn('delivery failed (network)', { deliveryId, reason, attempt: attempts, willRetry })
    return { done: !willRetry, retryInMs: willRetry ? retryDelayMs(attempts) : undefined }
  }
}
