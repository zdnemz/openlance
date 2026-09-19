/**
 * /overview + /health + /ready — public status surface that powers the
 * backend console UI and uptime checks. No auth: contains counts + latest
 * ledger rows + config summary only.
 */
import { count, desc, eq } from 'drizzle-orm'
import { env } from '../config'
import { execSql, getDb } from '../db'
import { cached } from '../lib/cache'
import { getKv } from '../lib/kv'
import { getChainAdapter } from '../chain/adapter'
import {
  arbiters, jobs, ledgerEvents, messages, projectMilestones, projects, proposals, reviews, users,
} from '../db/schema'

export function health() {
  return {
    status: 'ok',
    service: 'openlance-api',
    version: '0.1.0',
    time: new Date().toISOString(),
  }
}

export async function ready() {
  const checks: Record<string, string> = {}
  try {
    getDb() // ensure the lazy singleton is initialised before raw SQL
    await execSql('select 1')
    checks.database = 'ok'
  } catch {
    checks.database = 'down'
  }
  try {
    const kv = await getKv()
    await kv.get('ready:probe')
    checks.kv = `ok (${kv.mode})`
  } catch {
    checks.kv = 'down'
  }
  checks.chain = `ok (${env.chainMode})`
  const isReady = Object.values(checks).every((v) => v.startsWith('ok'))
  return { ready: isReady, checks, mode: { db: env.databaseDriver, kv: env.queueMode === 'redis' ? 'redis' : 'in-process', chain: env.chainMode, storage: env.storageDriver } }
}

export async function overview() {
  return cached('overview', { ttlSeconds: 10, namespace: 'read' }, loadOverview)
}

async function loadOverview() {
  const db = getDb()
  const [[{ total: userCount }], [{ total: jobCount }], [{ total: projectCount }], [{ total: proposalCount }], [{ total: messageCount }], [{ total: reviewCount }], [{ total: ledgerCount }]] = await Promise.all([
    db.select({ total: count() }).from(users),
    db.select({ total: count() }).from(jobs),
    db.select({ total: count() }).from(projects),
    db.select({ total: count() }).from(proposals),
    db.select({ total: count() }).from(messages),
    db.select({ total: count() }).from(reviews),
    db.select({ total: count() }).from(ledgerEvents),
  ])

  const arbiterRows = await db.select().from(arbiters).orderBy(desc(arbiters.trustScore)).limit(10)
  const latestLedger = await db.select().from(ledgerEvents)
    .orderBy(desc(ledgerEvents.blockNumber), desc(ledgerEvents.logIndex)).limit(12)

  // milestone status histogram
  const milestones = await db.select({ chainStatus: projectMilestones.chainStatus }).from(projectMilestones)
  const histogram: Record<string, number> = {}
  for (const m of milestones) histogram[m.chainStatus] = (histogram[m.chainStatus] ?? 0) + 1

  // newest project snapshot (the demo project)
  const [newest] = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(1)
  let demoProject: unknown = null
  if (newest) {
    const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, newest.id)))
      .sort((a, b) => a.position - b.position)
    const [client] = await db.select().from(users).where(eq(users.id, newest.clientId)).limit(1)
    const [freelancer] = await db.select().from(users).where(eq(users.id, newest.freelancerId)).limit(1)
    demoProject = {
      id: newest.id, status: newest.status, createdAt: newest.createdAt,
      client: client ? { displayName: client.displayName, walletAddress: client.walletAddress } : null,
      freelancer: freelancer ? { displayName: freelancer.displayName, walletAddress: freelancer.walletAddress } : null,
      milestones: ms.map((m) => ({
        id: m.id, position: m.position, title: m.title, amountWei: m.amountWei,
        chainStatus: m.chainStatus, softStatus: m.softStatus, settlementTxHash: m.settlementTxHash,
      })),
    }
  }

  const adapter = getChainAdapter()
  return {
    service: 'openlance-api',
    config: {
      chainMode: adapter.mode,
      chainId: env.CHAIN_ID,
      feeBps: env.PLATFORM_FEE_BPS,
      dbDriver: env.databaseDriver,
      storageDriver: env.storageDriver,
      queueMode: env.queueMode,
      contracts: { escrow: adapter.escrowAddress, arbiterRegistry: adapter.registryAddress },
    },
    counts: {
      users: userCount, jobs: jobCount, projects: projectCount, proposals: proposalCount,
      messages: messageCount, reviews: reviewCount, ledgerEvents: ledgerCount,
    },
    milestoneHistogram: histogram,
    arbiters: arbiterRows,
    latestLedger,
    demoProject,
  }
}
