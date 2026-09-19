/** /admin — operator endpoints (why admin-gated: each is a trust lever). */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { requireAdmin } from '../auth/middleware'
import { runReconciliation } from '../chain/reconcile'
import { getMockAdapter } from '../chain/adapter'
import { indexerState, reconciliationRuns } from '../db/schema'

export async function adminOverview(request: Request) {
  await requireAdmin(request)
  const db = getDb()
  const checkpoints = await db.select().from(indexerState)
  const runs = await db.select().from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt)).limit(10)
  return { indexerCheckpoints: checkpoints, recentReconciliations: runs }
}

/** Trigger reconciliation on demand (also runs nightly). */
export async function adminReconcile(request: Request) {
  await requireAdmin(request)
  return runReconciliation()
}

export async function adminReconciliations(request: Request) {
  await requireAdmin(request)
  const db = getDb()
  return db.select().from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt)).limit(50)
}

/** Mock-chain state inspection (dev deployments only). */
export async function adminMockChain(request: Request) {
  await requireAdmin(request)
  return getMockAdapter().snapshot()
}

export async function adminResetIndexer(request: Request) {
  await requireAdmin(request)
  // Why admin-gated: resetting the checkpoint forces a full re-index; safe
  // (ingest is idempotent) but expensive and noisy.
  const db = getDb()
  await db.update(indexerState).set({ lastBlock: 0, updatedAt: new Date() })
    .where(eq(indexerState.id, 'escrow'))
  return { reset: true, note: 'checkpoint cleared; the poller will re-ingest from block 0 (idempotent)' }
}
