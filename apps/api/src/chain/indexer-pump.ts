/**
 * Real-mode indexer pump — the driver that turns on-chain logs into the DB
 * mirror.
 *
 * The `ChainAdapter.fetchLogs` + `ingestEvents` pair is the pipeline; nothing in
 * real mode called it, so on-chain activity never reached the mirror (milestones
 * stuck at `pending_funding`, arbiters empty, ledger empty). This module supplies
 * the missing loop:
 *
 *   1. read the last processed block from `indexer_state` ('escrow' checkpoint),
 *   2. fetch logs from `last+1` → latest (chunked by INDEXER_CHUNK_BLOCKS),
 *   3. ingest them (idempotent on tx_hash + log_index),
 *   4. advance the checkpoint to the latest INGESTED block.
 *
 * Confirmation lag: we only index up to `latest - INDEXER_CONFIRMATIONS` so a
 * shallow reorg cannot leave the mirror ahead of the chain. On anvil
 * (INDEXER_CONFIRMATIONS=1) this is a single block.
 *
 * Chain generation: a checkpoint that outlives its chain is the failure mode this
 * pump used to have silently. `if (safeTip < from) return empty` cannot tell
 * "chain is idle" from "checkpoint belongs to a chain that no longer exists", so
 * it returned an empty pass every poll and logged nothing — the indexer was dead
 * for three hours before a UNIQUE violation on `onchain_id` surfaced it as an
 * unrelated-looking 500. `ensureCurrentGeneration` now settles that question
 * before the early return, and the early return itself is no longer silent.
 *
 * Safe to run concurrently / repeatedly: ingests are idempotent, and the
 * checkpoint only ever moves forward. A thrown tick logs and returns 0 so the
 * scheduler keeps running.
 */
import { eq } from 'drizzle-orm'
import { env } from '../config.ts'
import { getDb } from '../db/index.ts'
import { logger } from '../lib/logger.ts'
import { getChainAdapter } from './adapter.ts'
import { ingestEvents } from './indexer.ts'
import { ensureCurrentGeneration } from './generation.ts'
import { indexerState } from '../db/schema.ts'

const log = logger.child({ component: 'indexer-pump' })

const CHECKPOINT_ID = 'escrow'

export interface PumpResult {
  fromBlock: number
  toBlock: number
  applied: number
  duplicates: number
  drifts: number
}

/**
 * Dedupe key for the "checkpoint is above the tip" error.
 *
 * The condition persists until someone intervenes, and the pump polls every
 * INDEXER_POLL_MS — without this, a wedge becomes a wall of identical lines that
 * buries everything else in the log. Keyed on the numbers so a genuinely NEW wedge
 * (different heights) still reports.
 */
let lastHeightWedge: string | null = null

/** Read the last indexed block — never below the block before the deploy. */
async function readCheckpoint(): Promise<number> {
  const db = getDb()
  const [row] = await db.select().from(indexerState).where(eq(indexerState.id, CHECKPOINT_ID)).limit(1)
  return Math.max(row?.lastBlock ?? 0, env.INDEXER_START_BLOCK - 1)
}

/** Upsert the checkpoint to `block` (never moves backwards). */
async function writeCheckpoint(block: number): Promise<void> {
  const db = getDb()
  await db
    .insert(indexerState)
    .values({ id: CHECKPOINT_ID, lastBlock: block, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: indexerState.id,
      set: { lastBlock: block, updatedAt: new Date() },
    })
}

/**
 * One indexing pass. Returns the processed range + ingest tallies. Never throws
 * for a transient RPC/DB error — logs and reports a zero-width pass so the
 * scheduler is not torn down.
 */
export async function runIndexerTick(): Promise<PumpResult> {
  const empty: PumpResult = { fromBlock: 0, toBlock: 0, applied: 0, duplicates: 0, drifts: 0 }
  const adapter = getChainAdapter()

  // Mock mode synthesizes events directly into the pipeline; nothing to poll.
  if (adapter.mode !== 'real') return empty

  try {
    const latest = await adapter.getLatestBlock()
    // Hold back confirmations so a reorg cannot race the mirror ahead.
    const safeTip = latest - env.INDEXER_CONFIRMATIONS

    // Before anything else: is this mirror even pointed at a chain that exists?
    // A redeploy (`pnpm chain`) replaces the chain underneath a checkpoint that is
    // still in the database, and the guard below would then read as "nothing new"
    // on every poll forever. Dev rebuilds the mirror; production refuses to index
    // rather than delete money-adjacent state over an env change.
    if (!(await ensureCurrentGeneration(adapter, latest))) return empty
    lastHeightWedge = null

    const checkpoint = await readCheckpoint()
    const from = checkpoint + 1

    // A real chain only grows, so a checkpoint above the tip means the chain was
    // replaced and `ensureCurrentGeneration` declined to act (production). Name it
    // instead of returning a silent empty pass.
    if (checkpoint > latest) {
      const key = `${checkpoint}>${latest}`
      if (lastHeightWedge !== key) {
        lastHeightWedge = key
        log.error('indexer checkpoint is above the chain tip — indexing nothing', {
          checkpoint,
          latest,
          escrowAddress: adapter.escrowAddress,
          detail: 'the checkpoint belongs to a chain that no longer exists; every poll will skip until this is resolved',
          action: 'point ESCROW_ADDRESS at the live contract and rebuild the mirror, or restore the chain this checkpoint came from',
        })
      }
      return empty
    }

    if (safeTip < from) return empty // nothing new, or chain not yet deep enough

    let cursor = from
    const result: PumpResult = { fromBlock: from, toBlock: safeTip, applied: 0, duplicates: 0, drifts: 0 }

    while (cursor <= safeTip) {
      const to = Math.min(cursor + env.INDEXER_CHUNK_BLOCKS - 1, safeTip)
      const logs = await adapter.fetchLogs(cursor, to)
      const ingested = await ingestEvents(logs)
      result.applied += ingested.applied
      result.duplicates += ingested.duplicates
      result.drifts += ingested.drifts
      // Advance the checkpoint per chunk so a crash mid-range re-indexes at most
      // one chunk (idempotent), never the whole history.
      await writeCheckpoint(to)
      cursor = to + 1
    }

    if (result.applied || result.duplicates) {
      log.info('indexer tick', { from: result.fromBlock, to: result.toBlock, applied: result.applied, duplicates: result.duplicates })
    }
    return result
  } catch (err) {
    log.error('indexer tick failed', { err: String(err) })
    return empty
  }
}
