/**
 * Nightly reconciliation (PRD §7.3): the Postgres mirror is an untrusted cache
 * of chain state. This job re-derives every funded milestone's status from the
 * chain, repairs the mirror where it drifted (chain wins — it is the source of
 * truth), recomputes derived user stats from the ledger, and writes a report
 * with every drift it found. Drift here is a feature: it becomes the debugging
 * story, not a silent failure.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { logger } from '../lib/logger.ts'
import { getChainAdapter, type ChainAdapter } from './adapter.ts'
import { isTerminal, type MilestoneStatus } from '../domain/state-machine.ts'
import { ensureMilestoneOnchain } from '../modules/helpers.ts'
import { AppError } from '../lib/errors.ts'
import { ledgerEvents, projectMilestones, projects, reconciliationRuns, users } from '../db/schema.ts'
import type { ProjectMilestone } from '../db/schema.ts'

const log = logger.child({ component: 'reconcile' })

export interface DriftEntry {
  milestoneId: string
  onchainId: number
  mirrorStatus: string
  chainStatus: string | null
  /**
   * `unreachable` = RPC could not be read (mirror may be fine).
   * `conflicted`  = the onchain id is claimed by another row, so nothing can be
   * repaired until a human or a chain-generation rebuild resolves it. Reported
   * rather than thrown: an unresolvable row must not abort the solvency check and
   * the stats rebuild that follow it.
   */
  action: 'repaired' | 'unreachable' | 'conflicted'
}

export async function runReconciliation(): Promise<{ checked: number; drifts: number; report: DriftEntry[] }> {
  const db = getDb()
  const adapter = getChainAdapter()
  const [run] = await db.insert(reconciliationRuns).values({}).returning({ id: reconciliationRuns.id })

  const rows = await db.select().from(projectMilestones).where(isNotNull(projectMilestones.onchainId))
  const drifts: DriftEntry[] = []

  // Indexer-miss backfill: rows stuck at pending_funding with NO onchainId are
  // invisible to the drift check above (it needs an id to read). One getLogs
  // per stuck row finds the funding, if it ever landed.
  drifts.push(...(await backfillMissingOnchainIds(adapter)))

  for (const m of rows) {
    const chainStatus = await adapter.getMilestoneStatus(m.onchainId!).catch(() => null)
    if (chainStatus === null) {
      if (isTerminal(m.chainStatus)) continue // terminal + unreachable is fine (archive nodes...)
      drifts.push({ milestoneId: m.id, onchainId: m.onchainId!, mirrorStatus: m.chainStatus, chainStatus: null, action: 'unreachable' })
      continue
    }
    if (chainStatus !== m.chainStatus) {
      log.warn('reconciliation drift — repairing mirror to chain truth', {
        milestoneId: m.id, mirror: m.chainStatus, chain: chainStatus,
      })
      await db.update(projectMilestones).set({ chainStatus, updatedAt: new Date() })
        .where(eq(projectMilestones.id, m.id))
      drifts.push({ milestoneId: m.id, onchainId: m.onchainId!, mirrorStatus: m.chainStatus, chainStatus, action: 'repaired' })
    }
  }

  // Derived stats are recomputed from the event-sourced ledger (settlement events).
  const stats = await recomputeUserStats()

  // Solvency check (PRD §7.4 core invariant, server-side): on-chain escrow
  // balance vs mirror liabilities = Σ unsettled milestone amounts + unwithdrawn
  // fees. Real mode only — the mock moves no ETH (the invariant is enforced by
  // the Foundry suite in contracts/).
  const solvency = await checkSolvency(rows)
  if (solvency && !solvency.ok) {
    log.error('SOLVENCY DRIFT: escrow balance below liabilities', solvency)
  }

  const driftCount = drifts.length + stats.corrected + (solvency && !solvency.ok ? 1 : 0)

  await db.update(reconciliationRuns).set({
    finishedAt: new Date(), checked: rows.length, drifts: driftCount,
    report: { milestones: drifts, stats, solvency },
  }).where(eq(reconciliationRuns.id, run!.id))

  log.info('reconciliation complete', { checked: rows.length, drifts: driftCount })
  return { checked: rows.length, drifts: driftCount, report: drifts }
}

/**
 * Indexer-miss backfill: rows stuck at pending_funding with NO onchainId are
 * invisible to the drift check (it needs an id to read). The indexer joins
 * chain→row by ref, and `ref` is an indexed log topic — so one getLogs per
 * stuck row finds the funding, if it ever landed. A row with no funding log
 * is genuinely unfunded and stays pending. Repaired rows take the LIVE chain
 * status (it may have moved past funded while the mirror slept), plus the
 * funding tx hash/time the missed event would have recorded. No notifications
 * are fanned out — this is a quiet repair, not a new event.
 */
async function backfillMissingOnchainIds(adapter: ChainAdapter): Promise<DriftEntry[]> {
  if (adapter.mode !== 'real') return []
  const db = getDb()
  const stuck = await db.select().from(projectMilestones)
    .where(and(isNull(projectMilestones.onchainId), eq(projectMilestones.chainStatus, 'pending_funding')))
  const repaired: DriftEntry[] = []
  for (const m of stuck) {
    // A conflict here is a chain-mirror fact, not a transient error: another row
    // already owns this onchain id. Letting it propagate aborted the whole
    // reconcile run, so solvency and the stats rebuild below never executed — one
    // unresolvable row silently disabled every other check in the job. Record it
    // as drift and keep going.
    let current: ProjectMilestone
    let backfilled: boolean
    try {
      ;({ milestone: current, backfilled } = await ensureMilestoneOnchain(m))
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'chain_mirror_conflict') throw err
      log.error('reconciliation conflict — onchain id already claimed by another milestone', {
        milestoneId: m.id, detail: err.message,
      })
      repaired.push({
        milestoneId: m.id,
        onchainId: -1,
        mirrorStatus: m.chainStatus,
        chainStatus: null,
        action: 'conflicted',
      })
      continue
    }
    if (!backfilled) continue
    log.warn('reconciliation backfill — indexer missed the funding, repairing from chain', {
      milestoneId: m.id, onchainId: current.onchainId, chainStatus: current.chainStatus,
    })
    repaired.push({ milestoneId: m.id, onchainId: current.onchainId!, mirrorStatus: 'pending_funding', chainStatus: current.chainStatus, action: 'repaired' })
  }
  return repaired
}

/** balance ≥ Σ unsettled milestones + accrued (unwithdrawn) fees. */
async function checkSolvency(
  milestones: { amountWei: string; chainStatus: MilestoneStatus }[],
): Promise<{ ok: boolean; balanceWei: string; liabilitiesWei: string } | null> {
  const adapter = getChainAdapter()
  const balance = await adapter.getEscrowBalance().catch(() => null)
  if (balance === null) return null

  const unsettled = milestones
    .filter((m) => !isTerminal(m.chainStatus))
    .reduce((acc, m) => acc + BigInt(m.amountWei), 0n)

  const db = getDb()
  // Prefer the chain itself for unwithdrawn fees (accruedFees is already net
  // of withdrawals); the ledger sum is fallback for unreachable RPC.
  let feesAccrued = await adapter.getAccruedFees().then((v) => (v === null ? null : BigInt(v))).catch(() => null)
  let feesWithdrawn = 0n
  if (feesAccrued === null) {
    feesAccrued = 0n
    const ledger = await db
      .select({ eventType: ledgerEvents.eventType, payload: ledgerEvents.payload })
      .from(ledgerEvents)
    for (const ev of ledger) {
      const p = ev.payload as Record<string, unknown>
      if (ev.eventType === 'MilestoneReleased' || ev.eventType === 'MilestoneSplit') {
        feesAccrued += BigInt(String(p.fee ?? '0'))
      } else if (ev.eventType === 'FeeWithdrawn') {
        feesWithdrawn += BigInt(String(p.amount ?? '0'))
      }
    }
  }

  const liabilities = unsettled + (feesAccrued - feesWithdrawn)
  return { ok: BigInt(balance) >= liabilities, balanceWei: balance, liabilitiesWei: liabilities.toString() }
}

/** Rebuild totalEarned/totalPaid/completedProjects from ledger events + milestone states. */
export async function recomputeUserStats(): Promise<{ corrected: number }> {
  const db = getDb()
  const allUsers = await db.select().from(users)
  const allProjects = await db.select().from(projects)
  const allMilestones = await db.select().from(projectMilestones)

  const earned = new Map<string, bigint>() // userId → wei
  const paid = new Map<string, bigint>()
  for (const m of allMilestones) {
    if (!['released', 'resolved_release', 'resolved_split'].includes(m.chainStatus)) continue
    const project = allProjects.find((p) => p.id === m.projectId)
    if (!project) continue
    // The exact split amounts live in the ledger payload; approximate from the
    // milestone amount when the payload is unavailable (mirror is a cache).
    const ledger = await db.select().from(ledgerEvents).where(eq(ledgerEvents.milestoneOnchainId, m.onchainId ?? -1))
    let freelancerAmount = 0n
    let fee = 0n
    for (const ev of ledger) {
      const p = ev.payload as Record<string, unknown>
      if (ev.eventType === 'MilestoneReleased') {
        freelancerAmount = BigInt(String(p.principal ?? '0'))
        fee = BigInt(String(p.fee ?? '0'))
      } else if (ev.eventType === 'MilestoneSplit') {
        freelancerAmount = BigInt(String(p.freelancerAmount ?? '0'))
        fee = BigInt(String(p.fee ?? '0'))
      }
    }
    if (freelancerAmount === 0n) {
      // no ledger rows (e.g. mirror repaired ahead of indexer) — leave stats alone
      continue
    }
    earned.set(project.freelancerId, (earned.get(project.freelancerId) ?? 0n) + freelancerAmount)
    paid.set(project.clientId, (paid.get(project.clientId) ?? 0n) + freelancerAmount + fee)
  }

  const completed = new Map<string, { asClient: number; asFreelancer: number }>()
  for (const p of allProjects.filter((p) => p.status === 'completed')) {
    const c = completed.get(p.clientId) ?? { asClient: 0, asFreelancer: 0 }
    c.asClient++
    completed.set(p.clientId, c)
    const f = completed.get(p.freelancerId) ?? { asClient: 0, asFreelancer: 0 }
    f.asFreelancer++
    completed.set(p.freelancerId, f)
  }

  let corrected = 0
  for (const u of allUsers) {
    const expEarned = (earned.get(u.id) ?? 0n).toString()
    const expPaid = (paid.get(u.id) ?? 0n).toString()
    const expClient = completed.get(u.id)?.asClient ?? 0
    const expFreelancer = completed.get(u.id)?.asFreelancer ?? 0
    if (u.totalEarnedWei !== expEarned || u.totalPaidWei !== expPaid
      || u.completedProjectsAsClient !== expClient || u.completedProjectsAsFreelancer !== expFreelancer) {
      log.warn('correcting user stats from ledger', { user: u.walletAddress, from: { earned: u.totalEarnedWei, paid: u.totalPaidWei } })
      await db.update(users).set({
        totalEarnedWei: expEarned, totalPaidWei: expPaid,
        completedProjectsAsClient: expClient, completedProjectsAsFreelancer: expFreelancer,
        updatedAt: new Date(),
      }).where(eq(users.id, u.id))
      corrected++
    }
  }
  return { corrected }
}
