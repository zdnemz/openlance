/**
 * Background-worker bootstrap.
 *
 * The API runs entirely inside the Next.js process, so the periodic jobs
 * (chain indexer, SLA scan, nightly reconciliation) must be kicked off from
 * there. Historically nothing called `scheduleCron`, so the real-mode indexer
 * never ran and the DB mirror never updated.
 *
 * `bootstrapWorkers()` is idempotent and process-scoped: the first API request
 * (or any module that awaits it) schedules the crons exactly once. A module
 * `globalThis` guard survives Next.js dev hot-reloads so we don't stack
 * intervals on every edit.
 */
import { env } from '../config'
import { getQueues } from '../lib/queue'
import { logger } from '../lib/logger'
import { runIndexerTick } from '../chain/indexer-pump'
import { slaScan, reconcile } from './crons'

const log = logger.child({ component: 'workers' })

const globalForWorkers = globalThis as unknown as { __openlance_workers_booted?: boolean }

/**
 * Schedule the periodic workers. Safe to call repeatedly — only the first call
 * has an effect. Returns immediately; the jobs run on their intervals.
 */
export async function bootstrapWorkers(): Promise<void> {
  if (globalForWorkers.__openlance_workers_booted) return
  globalForWorkers.__openlance_workers_booted = true

  try {
    const queues = await getQueues()

    // Chain indexer — real mode only (mock synthesizes events inline).
    if (env.chainMode === 'real') {
      queues.scheduleCron('indexer', env.INDEXER_POLL_MS, runIndexerTick)
      // Kick one pass immediately so the first request sees fresh state without
      // waiting a full poll interval.
      void runIndexerTick().catch((err) => log.error('initial indexer tick failed', { err: String(err) }))
    }

    // Dispute SLA scan + nightly reconciliation.
    queues.scheduleCron('sla-scan', 15 * 60 * 1000, slaScan)
    queues.scheduleCron('reconcile', 24 * 60 * 60 * 1000, reconcile)

    log.info('workers bootstrapped', { chainMode: env.chainMode, pollMs: env.INDEXER_POLL_MS })
  } catch (err) {
    // Never let worker wiring break a request path.
    log.error('worker bootstrap failed', { err: String(err) })
    globalForWorkers.__openlance_workers_booted = false
  }
}
