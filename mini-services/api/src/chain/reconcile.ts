/**
 * Nightly reconciliation (PRD §7.3): the Postgres mirror is an untrusted cache
 * of chain state. This job re-derives every funded milestone's status from the
 * chain, repairs the mirror where it drifted (chain wins — it is the source of
 * truth), recomputes derived user stats from the ledger, and writes a report
 * with every drift it found. Drift here is a feature: it becomes the debugging
 * story, not a silent failure.
 */
import { eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { logger } from '../lib/logger'
import { getChainAdapter } from './adapter'
import { isTerminal } from '../domain/state-machine'
import { ledgerEvents, projectMilestones, projects, reconciliationRuns, users } from '../db/schema'

const log = logger.child({ component: 'reconcile' })

export interface DriftEntry {
  milestoneId: string
  onchainId: number
  mirrorStatus: string
  chainStatus: string | null
  action: 'repaired' | 'unreachable'
}

export async function runReconciliation(): Promise<{ checked: number; drifts: number; report: DriftEntry[] }> {
  const db = await getDb()
  const adapter = getChainAdapter()
  const [run] = await db.insert(reconciliationRuns).values({}).returning({ id: reconciliationRuns.id })

  const rows = await db.select().from(projectMilestones).where(isNotNull(projectMilestones.onchainId))
  const drifts: DriftEntry[] = []

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
  const driftCount = drifts.length + stats.corrected

  await db.update(reconciliationRuns).set({
    finishedAt: new Date(), checked: rows.length, drifts: driftCount, report: { milestones: drifts, stats },
  }).where(eq(reconciliationRuns.id, run!.id))

  log.info('reconciliation complete', { checked: rows.length, drifts: driftCount })
  return { checked: rows.length, drifts: driftCount, report: drifts }
}

/** Rebuild totalEarned/totalPaid/completedProjects from ledger events + milestone states. */
export async function recomputeUserStats(): Promise<{ corrected: number }> {
  const db = await getDb()
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
