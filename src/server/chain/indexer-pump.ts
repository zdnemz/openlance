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
 * Safe to run concurrently / repeatedly: ingests are idempotent, and the
 * checkpoint only ever moves forward. A thrown tick logs and returns 0 so the
 * scheduler keeps running.
 */
import { eq } from 'drizzle-orm'
import { env } from '../config'
import { getDb } from '../db'
import { logger } from '../lib/logger'
import { getChainAdapter } from './adapter'
import { ingestEvents } from './indexer'
import { indexerState } from '../db/schema'

const log = logger.child({ component: 'indexer-pump' })

const CHECKPOINT_ID = 'escrow'

export interface PumpResult {
  fromBlock: number
  toBlock: number
  applied: number
  duplicates: number
  drifts: number
}

/** Read the last indexed block (0 when the checkpoint row is absent). */
async function readCheckpoint(): Promise<number> {
  const db = getDb()
  const [row] = await db.select().from(indexerState).where(eq(indexerState.id, CHECKPOINT_ID)).limit(1)
  return row?.lastBlock ?? 0
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
    const from = (await readCheckpoint()) + 1
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
