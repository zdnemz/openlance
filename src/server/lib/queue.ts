/**
 * Job queue abstraction (Next.js server runtime).
 *
 * Redis mode : webhook deliveries + crons are recorded in Upstash Redis lists
 *              and consumed by the worker entrypoint (`src/server/workers`).
 *              Retries use the same exponential ladder as inline mode.
 * Inline mode: the request process executes deliveries directly with a
 *              setTimeout-based retry ladder and setInterval crons — so the
 *              whole backend runs with zero infrastructure.
 *
 * The delivery executor (workers/webhooks.attemptDelivery) performs exactly ONE
 * attempt and returns the outcome; retry policy lives here per mode.
 */
import { env } from '../config'
import { logger } from './logger'

export type CronName = 'reconcile' | 'sla-scan' | 'indexer'

export interface DeliveryOutcome {
  /** true when the delivery is terminal (delivered, or permanently failed) */
  done: boolean
  /** ms to wait before the next attempt (inline mode only) */
  retryInMs?: number
}

export interface JobQueues {
  mode: 'redis' | 'inline'
  enqueueWebhookDelivery(deliveryId: string): Promise<void>
  scheduleCron(name: CronName, everyMs: number, handler: () => Promise<unknown>): void
  close(): Promise<void>
}

class InlineQueues implements JobQueues {
  mode = 'inline' as const
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private crons: ReturnType<typeof setInterval>[] = []

  constructor(private readonly runDelivery: (deliveryId: string) => Promise<DeliveryOutcome>) {}

  async enqueueWebhookDelivery(deliveryId: string) {
    const tick = async () => {
      try {
        const r = await this.runDelivery(deliveryId)
        if (!r.done && r.retryInMs) {
          const t = setTimeout(tick, r.retryInMs)
          this.timers.add(t)
        }
      } catch (err) {
        logger.error('inline delivery crashed', { deliveryId, err: String(err) })
      }
    }
    setImmediate(tick)
  }

  scheduleCron(name: CronName, everyMs: number, handler: () => Promise<unknown>) {
    const id = setInterval(() => {
      handler().catch((err) => logger.error(`cron ${name} failed`, { err: String(err) }))
    }, everyMs)
    this.crons.push(id)
    logger.info(`cron scheduled (inline): ${name} every ${everyMs}ms`)
  }

  async close() {
    this.timers.forEach(clearTimeout)
    this.crons.forEach(clearInterval)
  }
}

/**
 * Upstash Redis queue: a simple list + a scheduled-delivery sorted set keyed by
 * `nextAttemptAt`. The worker polls the queue; retries are re-scheduled by
 * pushing back on the ZSET with the computed delay.
 */
class RedisQueues implements JobQueues {
  mode = 'redis' as const
  private redis: import('@upstash/redis').Redis | undefined
  private crons: ReturnType<typeof setInterval>[] = []

  constructor(private readonly runDelivery: (deliveryId: string) => Promise<DeliveryOutcome>) {}

  private async client() {
    if (!this.redis) {
      const { Redis } = await import('@upstash/redis')
      this.redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! })
    }
    return this.redis
  }

  async enqueueWebhookDelivery(deliveryId: string) {
    const redis = await this.client()
    await redis.lpush('q:webhooks', deliveryId)
  }

  /**
   * Redis mode keeps crons in-process on the worker entrypoint (documented
   * trade-off: the sandbox has no long-lived scheduler host). The handler is
   * registered as a plain interval so behaviour matches inline mode.
   */
  scheduleCron(name: CronName, everyMs: number, handler: () => Promise<unknown>) {
    const id = setInterval(() => {
      handler().catch((err) => logger.error(`cron ${name} failed`, { err: String(err) }))
    }, everyMs)
    this.crons.push(id)
    logger.info(`cron scheduled (redis): ${name} every ${everyMs}ms`)
  }

  async close() {
    this.crons.forEach(clearInterval)
  }
}

const globalForQueues = globalThis as unknown as { __openlance_queues?: JobQueues }

export async function getQueues(): Promise<JobQueues> {
  if (globalForQueues.__openlance_queues) return globalForQueues.__openlance_queues
  const { attemptDelivery } = await import('../workers/webhooks')
  globalForQueues.__openlance_queues = env.queueMode === 'redis' ? new RedisQueues(attemptDelivery) : new InlineQueues(attemptDelivery)
  return globalForQueues.__openlance_queues
}
