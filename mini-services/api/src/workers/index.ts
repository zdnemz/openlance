/**
 * Worker entrypoint (`bun run worker`) — Redis/BullMQ mode.
 * Consumes the webhook delivery queue + cron repeatables, and (real chain
 * mode) runs the log poller. In inline mode (no Redis) the API process runs
 * all of this itself via lib/queue + workers/start-inline.
 */
import { env } from '../config'
import { logger } from '../lib/logger'
import { getQueues } from '../lib/queue'
import { attemptDelivery } from './webhooks'
import { reconcile, slaScan } from './crons'
import { ingestEvents } from '../chain/indexer'
import { getChainAdapter } from '../chain/adapter'
import { getDb } from '../lib/db'
import { indexerState } from '../db/schema'
import { eq } from 'drizzle-orm'

const log = logger.child({ component: 'worker' })

export async function startWorkers(opts: { crons: boolean; poller: boolean }): Promise<void> {
  const queues = await getQueues()

  if (env.queueMode === 'redis') {
    const { Worker, Queue } = await import('bullmq')
    const connection = { url: env.REDIS_URL! } as never
    new Worker('webhooks', async (job) => {
      if (job.name.startsWith('cron:')) {
        if (job.name === 'cron:reconcile') return reconcile()
        if (job.name === 'cron:sla-scan') return slaScan()
        return
      }
      const outcome = await attemptDelivery((job.data as { deliveryId: string }).deliveryId)
      if (!outcome.done) throw new Error(`retry in ${outcome.retryInMs}ms`) // BullMQ backoff owns timing
    }, { connection, concurrency: 5 })
    log.info('bullmq worker consuming: webhooks')
    if (opts.crons) {
      const q = new Queue('webhooks', { connection })
      await q.upsertJobScheduler('cron:sla-scan', { every: 15 * 60_000 }, { name: 'cron:sla-scan', data: {} })
      await q.upsertJobScheduler('cron:reconcile', { every: 24 * 60 * 60_000 }, { name: 'cron:reconcile', data: {} })
      log.info('job-scheduler crons registered (sla-scan 15m, reconcile 24h)')
    }
  } else if (opts.crons) {
    queues.scheduleCron('sla-scan', 15 * 60_000, slaScan)
    queues.scheduleCron('reconcile', 24 * 60 * 60_000, reconcile)
  }

  // Real-chain poller: checkpoint → latest-confirmations, chunked.
  if (opts.poller && env.chainMode === 'real') {
    const adapter = getChainAdapter()
    const db = await getDb()
    const tick = async () => {
      try {
        const [state] = await db.select().from(indexerState).where(eq(indexerState.id, 'escrow')).limit(1)
        const from = (state?.lastBlock ?? 0) + 1
        const latest = await adapter.getLatestBlock()
        const target = latest - env.INDEXER_CONFIRMATIONS
        if (target < from) return
        const end = Math.min(target, from + env.INDEXER_CHUNK_BLOCKS - 1)
        const logs = await adapter.fetchLogs(from, end)
        if (logs.length) await ingestEvents(logs)
        await db.insert(indexerState).values({ id: 'escrow', lastBlock: end })
          .onConflictDoUpdate({ target: indexerState.id, set: { lastBlock: end, updatedAt: new Date() } })
        log.info('poller advanced', { from, to: end, logs: logs.length })
      } catch (err) {
        log.error('poller tick failed', { err: String(err) })
      }
    }
    setInterval(tick, env.INDEXER_POLL_MS)
    void tick()
    log.info(`chain poller started (${env.INDEXER_POLL_MS}ms interval)`)
  }
}

// Standalone worker process entry
if (import.meta.main) {
  log.info('worker process starting', { queueMode: env.queueMode, chainMode: env.chainMode })
  await startWorkers({ crons: true, poller: true })
  const stop = () => {
    log.info('worker shutting down')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
