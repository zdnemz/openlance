/** /admin — operator endpoints (why admin-gated: each is a trust lever). */
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { ok } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAdmin } from '../auth/middleware'
import { runReconciliation } from '../chain/reconcile'
import { getMockAdapter } from '../chain/adapter'
import { indexerState, reconciliationRuns } from '../db/schema'

export const adminRoutes = new Hono()
adminRoutes.use('*', requireAdmin)

adminRoutes.get('/overview', readLimiter(), async (c) => {
  const db = await getDb()
  const checkpoints = await db.select().from(indexerState)
  const runs = await db.select().from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt)).limit(10)
  return ok(c, { indexerCheckpoints: checkpoints, recentReconciliations: runs })
})

/** Trigger reconciliation on demand (also runs nightly). */
adminRoutes.post('/reconcile', writeLimiter(), async (c) => {
  const result = await runReconciliation()
  return ok(c, result)
})

adminRoutes.get('/reconciliations', readLimiter(), async (c) => {
  const db = await getDb()
  const rows = await db.select().from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt)).limit(50)
  return ok(c, rows)
})

/** Mock-chain state inspection (dev deployments only). */
adminRoutes.get('/mock-chain', readLimiter(), async (c) => {
  const snapshot = await getMockAdapter().snapshot()
  return ok(c, snapshot)
})

adminRoutes.post('/indexer/reset', writeLimiter(), async (c) => {
  // Why admin-gated: resetting the checkpoint forces a full re-index; safe
  // (ingest is idempotent) but expensive and noisy.
  const db = await getDb()
  await db.update(indexerState).set({ lastBlock: 0, updatedAt: new Date() })
    .where(eq(indexerState.id, 'escrow'))
  return ok(c, { reset: true, note: 'checkpoint cleared; the poller will re-ingest from block 0 (idempotent)' })
})
