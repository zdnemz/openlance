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
import { logger } from '../lib/logger'
import { getChainAdapter } from '../chain/adapter'
import { probeStorage, storageConfig } from '../storage'
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
  checks.storage = await probeStorage()
  const isReady = Object.values(checks).every((v) => v.startsWith('ok'))
  return { ready: isReady, checks, mode: { db: env.databaseDriver, kv: env.queueMode === 'redis' ? 'redis' : 'in-process', chain: env.chainMode, storage: env.storageDriver } }
}

export async function overview() {
  return cached('overview', { ttlSeconds: 10, namespace: 'read' }, loadOverview)
}

/**
 * Chain/runtime config — the contract addresses, fee and staking parameters the
 * client needs to transact. Deliberately DERIVED FROM ENV/ADAPTER ONLY, never
 * from the database: a DB hiccup must never strip the app of its contract
 * addresses (which surfaces as "contract address unknown" on the stake panel).
 */
export function runtimeConfig() {
  const adapter = getChainAdapter()
  const minStakeWei = env.MIN_STAKE_WEI
  let tierSilverWei = '0'
  let tierGoldWei = '0'
  try {
    tierSilverWei = (BigInt(minStakeWei) * 10n).toString()
    tierGoldWei = (BigInt(minStakeWei) * 100n).toString()
  } catch { /* env guard rails on malformed wei */ }
  return {
    chainMode: adapter.mode,
    chainId: env.CHAIN_ID,
    feeBps: env.PLATFORM_FEE_BPS,
    disputeFeeWei: env.DISPUTE_FEE_WEI,
    minStakeWei,
    tierSilverWei,
    tierGoldWei,
    minScoreToWithdraw: env.MIN_SCORE_TO_WITHDRAW,
    minStakeDurationSeconds: env.MIN_STAKE_DURATION_SECONDS,
    unstakeCooldownSeconds: env.UNSTAKE_COOLDOWN_SECONDS,
    commitWindowSeconds: env.COMMIT_WINDOW_SECONDS,
    revealWindowSeconds: env.REVEAL_WINDOW_SECONDS,
    appealWindowSeconds: env.APPEAL_WINDOW_SECONDS,
    dbDriver: env.databaseDriver,
    storageDriver: env.storageDriver,
    queueMode: env.queueMode,
    storage: storageConfig(),
    contracts: {
      escrow: adapter.escrowAddress,
      arbiterRegistry: adapter.registryAddress,
      timelock: env.TIMELOCK_ADDRESS ?? null,
      sponsorshipForwarder: env.sponsorship.forwarderAddress,
    },
    // Gasless sponsorship: when enabled, signed-in users pay no gas (relayer
    // fronts it). The client uses `enabled` to decide whether to route money
    // actions through /api/relay.
    sponsorship: {
      enabled: env.sponsorship.enabled,
      sessionTtlSeconds: env.sponsorship.sessionTtlSeconds,
      eip712: {
        domain: { name: 'OpenLance SponsorshipForwarder', version: '1' },
      },
    },
  }
}

/** How many roles the overview exposes as NaN-safe zero when the DB is down. */
const EMPTY_COUNTS = { users: 0, jobs: 0, projects: 0, proposals: 0, messages: 0, reviews: 0, ledgerEvents: 0 }

async function loadOverview() {
  const config = runtimeConfig() as Record<string, unknown> & { tierSilverWei: string; tierGoldWei: string; minStakeDurationSeconds: number; unstakeCooldownSeconds: number }

  // KV-synced registry tuning (setTierThresholds / setMinStakeDuration /
  // setUnstakeCooldown) overrides env defaults so /overview stays pixel-perfect
  // with tierOf/isEligible after admin retunes. KV failure → env defaults.
  try {
    const kv = await getKv()
    const [s, g, d, c] = await Promise.all([
      kv.get('registry:tierSilver'), kv.get('registry:tierGold'),
      kv.get('registry:minStakeDuration'), kv.get('registry:unstakeCooldown'),
    ])
    if (s) config.tierSilverWei = s
    if (g) config.tierGoldWei = g
    if (d && Number(d) >= 0) config.minStakeDurationSeconds = Number(d)
    if (c && Number(c) >= 0) config.unstakeCooldownSeconds = Number(c)
  } catch { /* env defaults stand */ }

  // Everything below is DATA, not config. If the database is unreachable we
  // still return a valid response with empty data — so the client always gets
  // the contract addresses and can render the stake panel even mid-outage.
  let counts = { ...EMPTY_COUNTS }
  let arbiterRows: (typeof arbiters.$inferSelect)[] = []
  let latestLedger: (typeof ledgerEvents.$inferSelect)[] = []
  const histogram: Record<string, number> = {}
  let demoProject: unknown = null

  try {
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
    counts = { users: userCount, jobs: jobCount, projects: projectCount, proposals: proposalCount, messages: messageCount, reviews: reviewCount, ledgerEvents: ledgerCount }

    arbiterRows = await db.select().from(arbiters).orderBy(desc(arbiters.trustScore)).limit(10)
    latestLedger = await db.select().from(ledgerEvents)
      .orderBy(desc(ledgerEvents.blockNumber), desc(ledgerEvents.logIndex)).limit(12)

    // milestone status histogram
    const milestones = await db.select({ chainStatus: projectMilestones.chainStatus }).from(projectMilestones)
    for (const m of milestones) histogram[m.chainStatus] = (histogram[m.chainStatus] ?? 0) + 1

    // newest project snapshot (the demo project)
    const [newest] = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(1)
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
  } catch (err) {
    // Degrade, don't fail: the config block above is the client's lifeline.
    logger.warn('overview: database unavailable — returning config with empty data', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    service: 'openlance-api',
    config,
    counts,
    milestoneHistogram: histogram,
    arbiters: arbiterRows,
    latestLedger,
    demoProject,
  }
}
