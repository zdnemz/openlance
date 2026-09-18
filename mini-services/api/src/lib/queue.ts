/**
 * Job queue abstraction — BullMQ (Redis) when available, in-process otherwise.
 *
 * Redis mode  : `bun run worker` consumes jobs; BullMQ owns retries/backoff.
 * Inline mode : the API process executes jobs directly with a setTimeout-based
 *               retry ladder (same schedule) and setInterval crons — so the
 *               whole backend runs as a single process with zero infra.
 *
 * The delivery executor (workers/webhooks.attemptDelivery) performs exactly ONE
 * attempt and returns the outcome; retry policy lives here per mode.
 */
import { env } from '../config'
import { logger } from './logger'

export type CronName = 'reconcile' | 'sla-scan'

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

class BullMqQueues implements JobQueues {
  mode = 'redis' as const
  private queue?: import('bullmq').Queue

  constructor(private readonly runDelivery: (deliveryId: string) => Promise<DeliveryOutcome>) {}

  private async getQueue(): Promise<import('bullmq').Queue> {
    if (!this.queue) {
      const { Queue } = await import('bullmq')
      this.queue = new Queue('webhooks', { connection: { url: env.REDIS_URL! } as never })
    }
    return this.queue
  }

  async enqueueWebhookDelivery(deliveryId: string) {
    const q = await this.getQueue()
    await q.add('deliver', { deliveryId }, {
      attempts: env.WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    })
  }

  /** Redis mode registers job-scheduler-driven repeatables; the worker process attaches handlers. */
  async scheduleCron(name: CronName, everyMs: number, _handler: () => Promise<void>) {
    void _handler
    const q = await this.getQueue()
    await q.upsertJobScheduler(`cron:${name}`, { every: everyMs }, { name: `cron:${name}`, data: {} })
    logger.info(`cron scheduled (bullmq): ${name} every ${everyMs}ms`)
  }

  async close() {
    await this.queue?.close()
  }
}

let queues: JobQueues | undefined

export async function getQueues(): Promise<JobQueues> {
  if (queues) return queues
  const { attemptDelivery } = await import('../workers/webhooks')
  queues = env.queueMode === 'redis' ? new BullMqQueues(attemptDelivery) : new InlineQueues(attemptDelivery)
  return queues
}
