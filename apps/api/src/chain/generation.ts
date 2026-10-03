/**
 * Chain generation — is the mirror still pointed at a chain that exists?
 *
 * The mirror is an untrusted cache of chain state, and it caches *one* chain: the
 * `indexer_state` checkpoint plus every `onchain_id`, ledger row and derived stat
 * derived from it. Nothing in that cache records WHICH chain it came from, so a
 * chain that is replaced underneath it is indistinguishable from a chain that is
 * merely idle. On anvil that happens every single `pnpm chain` run: blocks restart
 * at 0, milestone ids restart at 1, and every contract is redeployed at a fresh
 * address.
 *
 * The failure this module exists to prevent, observed end to end: the checkpoint
 * (2665) was left above the new chain's tip (586), so `runIndexerTick` took its
 * "nothing new" branch on every poll forever and the pump logged nothing at all.
 * The mirror never learned about a funding, the milestone stayed at
 * `pending_funding` with a NULL `onchain_id`, and the only remaining path —
 * resolve-on-write backfill — tried to claim `onchain_id = 1`, which the previous
 * boot's row still owned, so the freelancer's submission died on a UNIQUE
 * violation with a raw SQL dump for an error message.
 *
 * Two independent facts identify a replaced chain:
 *
 *   1. the escrow ADDRESS changed — a redeploy cannot keep it (CHAIN_ID cannot do
 *      this job: every anvil boot is 31337, so the id is constant across exactly
 *      the restarts we need to catch);
 *   2. the checkpoint is ABOVE the chain tip — a real chain only grows, so the
 *      only way `last_block` can exceed the tip is that the chain underneath
 *      changed. (A shallow reorg cannot do it either: the pump holds back
 *      INDEXER_CONFIRMATIONS, so the checkpoint is always at or below the tip.)
 *
 * Detection is deliberately separate from the response. What to DO about a
 * detected replacement is a policy decision, and it differs sharply by
 * environment: in development a redeploy is routine and the mirror is disposable,
 * so it is rebuilt automatically; in production a changed escrow address means
 * the operator pointed the service at a different contract, and silently deleting
 * money-adjacent mirror state would be far worse than refusing to index.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { env } from '../config.ts'
import { getDb } from '../db/index.ts'
import { logger } from '../lib/logger.ts'
import { disputes, indexerState, ledgerEvents, projectMilestones, projects, users } from '../db/schema.ts'
import type { ChainAdapter } from './adapter.ts'

const log = logger.child({ component: 'chain-generation' })

const CHECKPOINT_ID = 'escrow'

export type GenerationVerdict =
  /** No checkpoint row yet — nothing has ever been indexed. */
  | { kind: 'fresh'; liveAddress: string }
  /**
   * A checkpoint exists but predates generation tracking (`contract_address` is
   * NULL), so we cannot know which chain it belongs to. Adopt the live address
   * WITHOUT resetting.
   *
   * This asymmetry is the whole point: shipping the `contract_address` column
   * must not retroactively wipe a live production mirror on its first tick. An
   * existing mirror keeps indexing until it proves it is on the wrong chain. The
   * height signal above still catches a genuinely stale checkpoint, which is what
   * happens on a dev database that was mid-wedge when the column landed.
   */
  | { kind: 'adopt'; liveAddress: string; lastBlock: number }
  /** Checkpoint and address agree — still mirroring the same chain. */
  | { kind: 'same'; liveAddress: string; lastBlock: number }
  /**
   * The chain underneath the mirror was replaced. `signals` lists which facts
   * fired, so the log can say *why* rather than just that something changed.
   */
  | {
    kind: 'changed'
    liveAddress: string
    lastBlock: number
    tip: number
    signals: GenerationSignal[]
    previousAddress: string | null
  }

export type GenerationSignal = 'address' | 'height'

/** Compare the recorded generation against the live chain. Read-only. */
export async function detectGeneration(adapter: ChainAdapter, tip: number): Promise<GenerationVerdict> {
  const db = getDb()
  const [row] = await db.select().from(indexerState).where(eq(indexerState.id, CHECKPOINT_ID)).limit(1)
  const liveAddress = adapter.escrowAddress.toLowerCase()

  if (!row) return { kind: 'fresh', liveAddress }

  const lastBlock = row.lastBlock
  const recorded = row.contractAddress?.toLowerCase() ?? null
  if (recorded === null) return { kind: 'adopt', liveAddress, lastBlock }

  const signals: GenerationSignal[] = []
  if (recorded !== liveAddress) signals.push('address')
  if (lastBlock > tip) signals.push('height')

  if (signals.length === 0) return { kind: 'same', liveAddress, lastBlock }
  return { kind: 'changed', liveAddress, lastBlock, tip, signals, previousAddress: recorded }
}

/** Point the checkpoint at the live chain without touching anything else. */
async function recordGeneration(liveAddress: string, lastBlock: number): Promise<void> {
  await getDb()
    .insert(indexerState)
    .values({ id: CHECKPOINT_ID, lastBlock, contractAddress: liveAddress, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: indexerState.id,
      set: { contractAddress: liveAddress, updatedAt: new Date() },
    })
}

/**
 * Whether a detected replacement may be repaired automatically.
 *
 * Production refuses. The mirror carries `onchain_id` claims, settlement records
 * and derived payouts; discarding them because an operator edited an env var is
 * not a decision software should make on its own, so the caller is expected to
 * log loudly and stop indexing until a human says what happened.
 */
export function canAutoReset(): boolean {
  return env.NODE_ENV === 'development'
}

/**
 * Rebuild the mirror for a new chain generation, inside one transaction.
 *
 * The rule: everything THE CHAIN asserted is void; everything HUMANS created
 * survives. So the checkpoint rewinds, chain-derived columns fall back to their
 * "never happened" defaults, and the ledger is dropped wholesale (it is pure chain
 * output, and it is what `recomputeUserStats` reads — leaving the dead chain's
 * events in place would keep paying users for settlements that no longer exist).
 * Users, jobs, proposals, projects, messages, submissions, reviews, attachments
 * and notifications are untouched: `db:flush` deletes those too, but they are
 * records of work, not of chain state, and there is no reason to lose them.
 *
 * Returns the counts it cleared, so the caller can log a real summary instead of
 * a bare "reset done".
 */
export async function resetMirrorForNewChain(
  verdict: Extract<GenerationVerdict, { kind: 'changed' }>,
): Promise<{ milestones: number; disputes: number; ledger: number }> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const milestones = await tx
      .update(projectMilestones)
      .set({
        onchainId: null,
        chainStatus: 'pending_funding',
        fundedTxHash: null,
        fundedAt: null,
        submittedAt: null,
        settledAt: null,
        settlementTxHash: null,
        withdrawnAt: null,
        withdrawTxHash: null,
        updatedAt: new Date(),
      })
      .where(isNotNull(projectMilestones.onchainId))
      .returning({ id: projectMilestones.id })

    // A dispute row is one-per-milestone and its round/phase/tally is a pure
    // mirror of the dead chain's dispute. `status` returns to 'open' rather than
    // being deleted: the row records that these two parties were in arbitration,
    // and on the new chain that dispute has not been opened yet — round 0 is free.
    const disputeRows = await tx
      .update(disputes)
      .set({
        status: 'open',
        round: 0,
        phase: 'none',
        selectedArbiters: sql`'[]'::jsonb`,
        commitDeadline: null,
        revealDeadline: null,
        appealCount: 0,
        tally: sql`'{}'::jsonb`,
        revealedArbiters: sql`'[]'::jsonb`,
        committedArbiters: sql`'[]'::jsonb`,
        finalized: false,
        finalizedAt: null,
        resolvedArbiter: null,
        outcome: null,
        resolutionTxHash: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .returning({ id: disputes.id })

    const ledger = await tx.delete(ledgerEvents).returning({ id: ledgerEvents.id })

    // Derived user stats and completed-project counts are recomputed from the
    // ledger by reconcile.ts; with the ledger gone they have no basis, so zero
    // them here rather than leave last chain's payouts on screen.
    await tx
      .update(users)
      .set({
        totalEarnedWei: '0',
        totalPaidWei: '0',
        completedProjectsAsClient: 0,
        completedProjectsAsFreelancer: 0,
        updatedAt: new Date(),
      })
      .where(
        sql`${users.totalEarnedWei} <> '0' or ${users.totalPaidWei} <> '0'
            or ${users.completedProjectsAsClient} <> 0 or ${users.completedProjectsAsFreelancer} <> 0`,
      )

    // `projects.status = 'completed'` is written by the indexer when the last
    // milestone settles (indexer.ts maybeCompleteProject), so it is a chain
    // assertion too.
    await tx
      .update(projects)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(projects.status, 'completed')))

    await tx
      .insert(indexerState)
      .values({ id: CHECKPOINT_ID, lastBlock: 0, contractAddress: verdict.liveAddress, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: indexerState.id,
        set: { lastBlock: 0, contractAddress: verdict.liveAddress, updatedAt: new Date() },
      })

    log.warn('chain mirror rebuilt for a new chain generation', {
      signals: verdict.signals,
      previousAddress: verdict.previousAddress,
      liveAddress: verdict.liveAddress,
      abandonedCheckpoint: verdict.lastBlock,
      liveTip: verdict.tip,
      cleared: { milestones: milestones.length, disputes: disputeRows.length, ledger: ledger.length },
    })

    return { milestones: milestones.length, disputes: disputeRows.length, ledger: ledger.length }
  })
}

/**
 * The pump's per-tick gate. Returns true when indexing may proceed.
 *
 * - `changed` + dev → rebuild, then index from block 0.
 * - `changed` + production → refuse, loudly, and index nothing.
 * - `adopt` → record the live address so the next tick has a baseline, and carry
 *   on from the existing checkpoint untouched.
 */
export async function ensureCurrentGeneration(adapter: ChainAdapter, tip: number): Promise<boolean> {
  const verdict = await detectGeneration(adapter, tip)

  switch (verdict.kind) {
    case 'fresh':
    case 'same':
      return true

    case 'adopt':
      await recordGeneration(verdict.liveAddress, verdict.lastBlock)
      log.info('indexer generation tracking adopted', {
        liveAddress: verdict.liveAddress,
        lastBlock: verdict.lastBlock,
        note: 'checkpoint predates generation tracking — adopted without resetting',
      })
      return true

    case 'changed': {
      const why = verdict.signals.includes('address')
        ? `escrow address changed (${verdict.previousAddress} → ${verdict.liveAddress})`
        : `checkpoint ${verdict.lastBlock} is above the chain tip ${verdict.tip}`
      if (!canAutoReset()) {
        log.error('CHAIN GENERATION CHANGED — refusing to index', {
          signals: verdict.signals,
          previousAddress: verdict.previousAddress,
          liveAddress: verdict.liveAddress,
          abandonedCheckpoint: verdict.lastBlock,
          liveTip: verdict.tip,
          detail: why,
          action: 'the mirror points at a chain that no longer exists. Indexing is paused so no mirror state is destroyed by an env change. Verify ESCROW_ADDRESS, then rebuild deliberately.',
        })
        return false
      }
      await resetMirrorForNewChain(verdict)
      return true
    }
  }
}

/** Exported for the reconcile job's report: rows stuck with no id, pre-reset. */
export async function countUnindexedMilestones(): Promise<number> {
  const rows = await getDb()
    .select({ id: projectMilestones.id })
    .from(projectMilestones)
    .where(and(isNull(projectMilestones.onchainId), eq(projectMilestones.chainStatus, 'pending_funding')))
  return rows.length
}
