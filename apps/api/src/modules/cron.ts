/**
 * Scheduled jobs, driven by an external pinger instead of `setInterval`.
 *
 * `bootstrapWorkers()` schedules the indexer, SLA scan and reconciliation on
 * in-process intervals. That works on a long-lived Node server and nowhere
 * else: a Vercel Function is frozen the moment it returns a response, so an
 * interval scheduled during a request never fires again. The chain mirror
 * would silently stop updating — milestones stuck at `pending_funding`, the
 * ledger empty — with nothing in the logs to say why.
 *
 * So on a serverless host the same three jobs run here instead, driven by an
 * external scheduler (cron-job.org, Upstash QStash, GitHub Actions) that GETs
 * this route on the cadence each job actually wants. Vercel's own Cron Jobs
 * would work too, but Hobby caps them at once per day — useless for an
 * indexer that wants to track the chain tip.
 *
 * Auth is `CRON_SECRET` as a bearer token. Unset → 404, matching the inbound
 * webhook endpoint: a deployment that has not opted in does not expose a
 * public "run the indexer" button.
 *
 * Concurrency: two pings can overlap, and the indexer is explicitly safe for
 * that (idempotent ingests, the checkpoint only moves forward). The nightly
 * reconcile is gated on a KV day-marker so a per-minute pinger does not run a
 * full reconciliation 1440 times a day.
 */
import { timingSafeEqual } from 'node:crypto'
import { and, eq, lte, or, isNull, asc } from 'drizzle-orm'
import { env } from '../config.ts'
import { getDb } from '../db/index.ts'
import { getKv } from '../lib/kv.ts'
import { logger } from '../lib/logger.ts'
import { Errors } from '../lib/errors.ts'
import { runIndexerTick } from '../chain/indexer-pump.ts'
import { slaScan, reconcile } from '../workers/crons.ts'
import { attemptDelivery } from '../workers/webhooks.ts'
import { webhookDeliveries } from '../db/schema.ts'

const log = logger.child({ component: 'cron' })

/** KV key holding the last day the nightly reconcile ran. */
const RECONCILE_DAY_KEY = 'cron:reconcile:day'

/** How many due deliveries one drain pass will attempt. */
const DRAIN_BATCH = 25

/**
 * Deliveries the inline/redis queue failed to hand off in time.
 *
 * `nextAttemptAt` is the retry ladder's own bookkeeping, so a row that is
 * `pending` with a due timestamp is work nobody has done yet. Draining from
 * the DATABASE rather than the queue list is what makes this survive
 * serverless: `enqueueWebhookDelivery` writes to an in-process timer (inline)
 * or a Redis list nothing reads (redis), and on a frozen function neither
 * ever runs. The database is the only durable record of outstanding work.
 */
async function drainDeliveries(): Promise<{ due: number; settled: number }> {
  const db = getDb()
  const now = new Date()
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now))))
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(DRAIN_BATCH)

  let settled = 0
  for (const { id } of due) {
    try {
      // `done` is false when the ladder wants another attempt later; either way
      // this row is off the due list, so it counts as handled.
      await attemptDelivery(id)
      settled++
    } catch (err) {
      // One bad endpoint must not strand the rest of the batch. attemptDelivery
      // records its own failure, so the row stays pending and retries later.
      log.error('delivery drain attempt failed', { deliveryId: id, err: String(err) })
    }
  }
  return { due: due.length, settled }
}

/** One pass of every scheduled job. Safe to call concurrently. */
export async function runScheduledJobs(): Promise<Record<string, unknown>> {
  const started = Date.now()
  const result: Record<string, unknown> = {}

  // Chain indexer — real mode only (mock synthesizes events inline).
  if (env.chainMode === 'real') {
    const tick = await runIndexerTick()
    result.indexer = { fromBlock: tick.fromBlock, toBlock: tick.toBlock, applied: tick.applied }
  } else {
    result.indexer = 'skipped (mock chain)'
  }

  result.slaScan = await slaScan()
  result.webhooks = await drainDeliveries()

  // Nightly reconciliation, gated to once per UTC day so a per-minute pinger
  // does not re-run a full mirror-vs-chain sweep on every tick.
  const kv = await getKv()
  const today = new Date().toISOString().slice(0, 10)
  if ((await kv.get(RECONCILE_DAY_KEY)) === today) {
    result.reconcile = 'already ran today'
  } else {
    result.reconcile = await reconcile()
    await kv.set(RECONCILE_DAY_KEY, today, 48 * 3600)
  }

  log.info('scheduled jobs complete', { ms: Date.now() - started, ...result })
  return result
}

/** Guard the route. Unset secret → the endpoint does not exist. */
export function authorizeCron(request: Request): void {
  const secret = env.CRON_SECRET
  if (!secret) throw Errors.notFound('Cron')
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  // Length-check first: timingSafeEqual throws on a length mismatch, and a
  // throw here would answer 500 and tell an attacker the secret's length.
  if (token.length !== secret.length || !timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
    throw Errors.unauthorized('Invalid cron token')
  }
}
