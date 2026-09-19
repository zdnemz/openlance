/**
 * /ledger — on-chain transaction history (PRD F13).
 * Pure projection of ledger_events (the event-sourced cache).
 */
import { and, count, desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { pagination } from '../lib/http'
import { env } from '../config'
import { ledgerEvents } from '../db/schema'

const EXPLORERS: Record<number, string> = {
  84532: 'https://sepolia.basescan.org/tx/', // Base Sepolia
}

function view(e: typeof ledgerEvents.$inferSelect) {
  return {
    id: e.id,
    chainId: e.chainId,
    eventType: e.eventType,
    blockNumber: e.blockNumber,
    blockTime: e.blockTime,
    txHash: e.txHash,
    explorerUrl: (EXPLORERS[e.chainId] ?? `https://explorer.example/tx/`) + e.txHash,
    contractAddress: e.contractAddress,
    milestoneOnchainId: e.milestoneOnchainId,
    projectId: e.projectId,
    payload: e.payload,
  }
}

export async function listLedger(request: Request) {
  const url = new URL(request.url)
  const { limit, offset } = pagination(url)
  const type = url.searchParams.get('type')
  const projectId = url.searchParams.get('projectId')
  const db = getDb()

  const conditions: import('drizzle-orm').SQL[] = []
  if (type) conditions.push(eq(ledgerEvents.eventType, type))
  if (projectId) conditions.push(eq(ledgerEvents.projectId, projectId))
  const where = conditions.length ? and(...conditions) : undefined

  const rows = await db.select().from(ledgerEvents).where(where)
    .orderBy(desc(ledgerEvents.blockNumber), desc(ledgerEvents.logIndex)).limit(limit).offset(offset)
  const [{ total }] = await db.select({ total: count() }).from(ledgerEvents).where(where)
  return { items: rows.map(view), total, limit, offset, chainId: env.CHAIN_ID }
}

export async function ledgerSummary() {
  const db = getDb()
  const rows = await db.select({ eventType: ledgerEvents.eventType }).from(ledgerEvents)
  const byType: Record<string, number> = {}
  for (const r of rows) byType[r.eventType] = (byType[r.eventType] ?? 0) + 1
  let feeAccrued = 0n
  let feeWithdrawn = 0n
  const all = await db.select({ eventType: ledgerEvents.eventType, payload: ledgerEvents.payload }).from(ledgerEvents)
  for (const e of all) {
    const p = e.payload as Record<string, unknown>
    if (e.eventType === 'MilestoneReleased' || e.eventType === 'MilestoneSplit') feeAccrued += BigInt(String(p.fee ?? '0'))
    if (e.eventType === 'FeeWithdrawn') feeWithdrawn += BigInt(String(p.amount ?? '0'))
  }
  return {
    totalEvents: rows.length,
    byType,
    fees: { accruedWei: feeAccrued.toString(), withdrawnWei: feeWithdrawn.toString(), pendingWei: (feeAccrued - feeWithdrawn).toString() },
  }
}
