/**
 * /ledger — on-chain transaction history (PRD F13).
 * Pure projection of ledger_events (the event-sourced cache). Every row links
 * to the explorer tx. The table is a cache — this API reads it as such.
 */
import { Hono } from 'hono'
import { and, count, desc, eq } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { ok, pagination } from '../lib/http'
import { readLimiter } from '../lib/rate-limit'
import { env } from '../config'
import { ledgerEvents } from '../db/schema'

export const ledgerRoutes = new Hono()

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

ledgerRoutes.get('/', readLimiter(), async (c) => {
  const { limit, offset } = pagination(c)
  const type = c.req.query('type')
  const projectId = c.req.query('projectId')
  const db = await getDb()

  const conditions = []
  if (type) conditions.push(eq(ledgerEvents.eventType, type))
  if (projectId) conditions.push(eq(ledgerEvents.projectId, projectId))
  const where = conditions.length ? and(...conditions) : undefined

  const rows = await db.select().from(ledgerEvents).where(where)
    .orderBy(desc(ledgerEvents.blockNumber), desc(ledgerEvents.logIndex)).limit(limit).offset(offset)
  const [{ total }] = await db.select({ total: count() }).from(ledgerEvents).where(where)
  return ok(c, { items: rows.map(view), total, limit, offset, chainId: env.CHAIN_ID })
})

ledgerRoutes.get('/summary', readLimiter(), async (c) => {
  const db = await getDb()
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
  return ok(c, {
    totalEvents: rows.length,
    byType,
    fees: { accruedWei: feeAccrued.toString(), withdrawnWei: feeWithdrawn.toString(), pendingWei: (feeAccrued - feeWithdrawn).toString() },
  })
})
