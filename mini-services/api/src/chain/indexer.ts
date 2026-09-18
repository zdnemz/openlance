/**
 * Chain event ingest — the event-sourcing pipeline (PRD F13).
 *
 * Every chain event (real logs or mock-synthesized) flows through here and is:
 *   1. recorded in ledger_events (idempotent on tx_hash + log_index),
 *   2. applied to the milestone/status mirrors via the state machine,
 *   3. folded into derived user stats,
 *   4. fanned out to the notification outbox → webhook deliveries.
 *
 * Re-processing the same logs is always a no-op (duplicates counted, skipped).
 * Illegal transitions are recorded in the ledger but NOT applied to mirrors —
 * they are drift, surfaced by reconciliation, never silently patched.
 */
import { eq, sql } from 'drizzle-orm'
import { env } from '../config'
import { getDb, type Db } from '../lib/db'
import { logger } from '../lib/logger'
import { getQueues } from '../lib/queue'
import {
  freelancerReceivedValue, isTerminal, nextMilestoneStatus,
} from '../domain/state-machine'
import type { NotificationType } from '../domain/notifications'
import { bytes32ToUuid } from './events'
import type { RawChainLog, EvMilestoneFunded } from './events'
import { outcomeFromUint8 } from './abi'
import {
  arbiters, disputes, ledgerEvents, projectMilestones, projects,
  users,
} from '../db/schema'
import { writeOutbox } from '../modules/notify'

const log = logger.child({ component: 'indexer' })

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface IngestResult {
  applied: number
  duplicates: number
  drifts: number
}

interface PlannedNotification {
  type: NotificationType
  actorAddress?: string | null
  projectId?: string | null
  milestoneId?: string | null
  payload?: Record<string, unknown>
}

/** Sort by (block, logIndex) so state is applied in chain order. */
export async function ingestEvents(logs: RawChainLog[]): Promise<IngestResult> {
  const result: IngestResult = { applied: 0, duplicates: 0, drifts: 0 }
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

  for (const evt of sorted) {
    const deliveryIds: string[] = []
    try {
      await (await getDb()).transaction(async (tx) => {
        const inserted = await tx
          .insert(ledgerEvents)
          .values({
            chainId: env.CHAIN_ID,
            blockNumber: evt.blockNumber,
            blockTime: evt.blockTime,
            txHash: evt.txHash,
            logIndex: evt.logIndex,
            contractAddress: evt.address,
            eventType: evt.name,
            milestoneOnchainId: numOrNull(evt.args.milestoneId),
            projectId: null,
            payload: evt.args as Record<string, unknown>,
          })
          .onConflictDoNothing({ target: [ledgerEvents.txHash, ledgerEvents.logIndex] })
          .returning({ id: ledgerEvents.id })
        if (inserted.length === 0) {
          result.duplicates++
          return
        }
        const ledgerId = inserted[0]!.id
        const notification = await applyEvent(tx, evt, ledgerId)
        if (notification) {
          deliveryIds.push(...(await writeOutbox(tx, notification)))
        }
        result.applied++
      })
      // Enqueue deliveries only after the transaction committed (transactional outbox).
      if (deliveryIds.length) {
        const queues = await getQueues()
        await Promise.all(deliveryIds.map((id) => queues.enqueueWebhookDelivery(id)))
      }
    } catch (err) {
      log.error('ingest failed for log', { txHash: evt.txHash, name: evt.name, err: String(err) })
      // One bad log must not block the stream — the reconciliation job will surface it.
    }
  }
  if (sorted.length) log.info('ingest complete', { ...result, logs: sorted.length })
  return result
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v)
}

/** Event-specific mirror updates. Returns a notification to fan out (or null). */
async function applyEvent(tx: Tx, evt: RawChainLog, ledgerId: number): Promise<PlannedNotification | null> {
  switch (evt.name) {
    case 'MilestoneFunded': return applyFunded(tx, evt, ledgerId)
    case 'MilestoneSubmitted': return applySubmitted(tx, evt)
    case 'MilestoneReleased': return applyReleased(tx, evt)
    case 'MilestoneRefunded': return applyRefunded(tx, evt)
    case 'MilestoneSplit': return applySplit(tx, evt)
    case 'MilestoneCancelled': return applyCancelled(tx, evt)
    case 'DisputeOpened': return applyDisputeOpened(tx, evt)
    case 'DisputeResolved': return applyDisputeResolved(tx, evt)
    case 'FeeWithdrawn': return null // ledger-only
    case 'ArbiterRegistered': return applyArbiterRegistered(tx, evt)
    case 'ArbiterDeregistered': return applyArbiterDeregistered(tx, evt)
    case 'TrustScoreUpdated': return applyTrustScore(tx, evt)
    default: return null
  }
}

async function loadMilestoneByOnchainId(tx: Tx, onchainId: number) {
  const rows = await tx.select().from(projectMilestones).where(eq(projectMilestones.onchainId, onchainId)).limit(1)
  return rows[0] ?? null
}

async function markSettled(tx: Tx, milestoneId: string, txHash: string, at: Date) {
  await tx.update(projectMilestones)
    .set({ settledAt: at, settlementTxHash: txHash, updatedAt: new Date() })
    .where(eq(projectMilestones.id, milestoneId))
}

/** Fold released/split value into derived user stats (event-sourced, never hand-edited). */
async function adjustStats(tx: Tx, projectId: string, freelancerAmount: string, clientOutflow: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return
  if (BigInt(freelancerAmount) > 0n) {
    await tx.update(users)
      .set({ totalEarnedWei: sql`${users.totalEarnedWei} + ${freelancerAmount}::numeric`, updatedAt: new Date() })
      .where(eq(users.id, project.freelancerId))
  }
  if (BigInt(clientOutflow) > 0n) {
    await tx.update(users)
      .set({ totalPaidWei: sql`${users.totalPaidWei} + ${clientOutflow}::numeric`, updatedAt: new Date() })
      .where(eq(users.id, project.clientId))
  }
}

/** Complete the project when every milestone is terminal. Idempotent via status guard. */
async function completeProjectIfDone(tx: Tx, projectId: string): Promise<boolean> {
  const open = await tx.select({ id: projectMilestones.id, status: projectMilestones.chainStatus })
    .from(projectMilestones).where(eq(projectMilestones.projectId, projectId))
  if (open.length === 0 || !open.every((m) => isTerminal(m.status))) return false
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project || project.status !== 'active') return false
  await tx.update(projects).set({ status: 'completed', updatedAt: new Date() }).where(eq(projects.id, projectId))
  await tx.update(users)
    .set({ completedProjectsAsClient: sql`${users.completedProjectsAsClient} + 1`, updatedAt: new Date() })
    .where(eq(users.id, project.clientId))
  await tx.update(users)
    .set({ completedProjectsAsFreelancer: sql`${users.completedProjectsAsFreelancer} + 1`, updatedAt: new Date() })
    .where(eq(users.id, project.freelancerId))
  return true
}

// ── Per-event appliers ──────────────────────────────────────────────────────
async function applyFunded(tx: Tx, evt: RawChainLog, ledgerId: number): Promise<PlannedNotification | null> {
  const args = evt.args as unknown as EvMilestoneFunded
  const ref = bytes32ToUuid(args.ref)
  if (!ref) {
    log.warn('MilestoneFunded with non-uuid ref', { txHash: evt.txHash })
    return null
  }
  const rows = await tx.select().from(projectMilestones).where(eq(projectMilestones.id, ref)).limit(1)
  const m = rows[0]
  if (!m) {
    log.warn('DRIFT: funded unknown milestone ref', { ref, txHash: evt.txHash })
    return null
  }
  if (m.chainStatus !== 'pending_funding') {
    log.warn('DRIFT: funding a milestone that is already ' + m.chainStatus, { ref, txHash: evt.txHash })
    return null
  }
  if (m.amountWei !== str(args.amount)) {
    log.warn('DRIFT: funded amount differs from mirror', { ref, mirror: m.amountWei, chain: str(args.amount) })
  }
  await tx.update(projectMilestones).set({
    onchainId: numOrNull(args.milestoneId),
    chainStatus: 'funded',
    fundedTxHash: evt.txHash,
    fundedAt: evt.blockTime,
    updatedAt: evt.blockTime,
  }).where(eq(projectMilestones.id, m.id))
  await tx.update(ledgerEvents).set({ projectId: m.projectId }).where(eq(ledgerEvents.id, ledgerId))
  return {
    type: 'milestone.funded',
    actorAddress: args.client,
    projectId: m.projectId,
    milestoneId: m.id,
    payload: { amount: str(args.amount), txHash: evt.txHash, position: m.position, title: m.title },
  }
}

async function applySubmitted(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('MilestoneSubmitted', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'MilestoneSubmitted')
  if (!legal) return drift('MilestoneSubmitted (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({
    chainStatus: to, submittedAt: evt.blockTime, softStatus: 'submitted', updatedAt: evt.blockTime,
  }).where(eq(projectMilestones.id, m.id))
  // The off-chain submission record already notified (F8/F9) — chain flip is mirror-only.
  return null
}

async function applyReleased(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('MilestoneReleased', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'MilestoneReleased')
  if (!legal) return drift('MilestoneReleased (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  await markSettled(tx, m.id, evt.txHash, evt.blockTime)
  if (freelancerReceivedValue(to)) {
    await adjustStats(tx, m.projectId, str(evt.args.principal), (BigInt(str(evt.args.principal)) + BigInt(str(evt.args.fee ?? '0'))).toString())
  }
  const completed = await completeProjectIfDone(tx, m.projectId)
  return {
    type: 'milestone.released',
    actorAddress: str((evt.args.viaDisputeResolution ? evt.args.arbiter : undefined) ?? evt.args.freelancer ?? '').toLowerCase() || null,
    projectId: m.projectId,
    milestoneId: m.id,
    payload: {
      principal: str(evt.args.principal), fee: str(evt.args.fee ?? '0'),
      viaDisputeResolution: Boolean(evt.args.viaDisputeResolution), txHash: evt.txHash,
      projectCompleted: completed,
    },
  }
}

async function applyRefunded(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('MilestoneRefunded', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'MilestoneRefunded')
  if (!legal) return drift('MilestoneRefunded (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  await markSettled(tx, m.id, evt.txHash, evt.blockTime)
  await completeProjectIfDone(tx, m.projectId)
  return {
    type: 'milestone.refunded',
    actorAddress: str(evt.args.client).toLowerCase(),
    projectId: m.projectId,
    milestoneId: m.id,
    payload: { amount: str(evt.args.amount), viaDisputeResolution: Boolean(evt.args.viaDisputeResolution), txHash: evt.txHash },
  }
}

async function applySplit(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('MilestoneSplit', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'MilestoneSplit')
  if (!legal) return drift('MilestoneSplit (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  await markSettled(tx, m.id, evt.txHash, evt.blockTime)
  const freelancerAmount = str(evt.args.freelancerAmount)
  const fee = str(evt.args.fee ?? '0')
  await adjustStats(tx, m.projectId, freelancerAmount, (BigInt(freelancerAmount) + BigInt(fee)).toString())
  const completed = await completeProjectIfDone(tx, m.projectId)
  return {
    type: 'milestone.split',
    actorAddress: null,
    projectId: m.projectId,
    milestoneId: m.id,
    payload: { clientAmount: str(evt.args.clientAmount), freelancerAmount, fee, txHash: evt.txHash, projectCompleted: completed },
  }
}

async function applyCancelled(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('MilestoneCancelled', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'MilestoneCancelled')
  if (!legal) return drift('MilestoneCancelled (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  await markSettled(tx, m.id, evt.txHash, evt.blockTime)
  await completeProjectIfDone(tx, m.projectId)
  return null // client-side cancel: no review unlock, no celebratory ping
}

async function applyDisputeOpened(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('DisputeOpened', id, evt.txHash)
  const { to, legal } = nextMilestoneStatus(m.chainStatus, 'DisputeOpened')
  if (!legal) return drift('DisputeOpened (illegal from ' + m.chainStatus + ')', id, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  // The off-chain POST /disputes already notified — chain event is confirmation only.
  return null
}

async function applyDisputeResolved(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('DisputeResolved', id, evt.txHash)
  const outcome = outcomeFromUint8(Number(evt.args.outcome))
  const [dispute] = await tx.select().from(disputes).where(eq(disputes.milestoneId, m.id)).limit(1)
  if (dispute) {
    await tx.update(disputes).set({
      status: 'resolved', outcome, resolvedArbiter: str(evt.args.arbiter).toLowerCase(),
      resolutionTxHash: evt.txHash, resolvedAt: evt.blockTime, updatedAt: evt.blockTime,
    }).where(eq(disputes.id, dispute.id))
  } else {
    log.warn('DRIFT: DisputeResolved with no off-chain dispute record', { milestoneId: m.id, txHash: evt.txHash })
  }
  return {
    type: 'dispute.resolved',
    actorAddress: str(evt.args.arbiter).toLowerCase(),
    projectId: m.projectId,
    milestoneId: m.id,
    payload: { outcome, txHash: evt.txHash },
  }
}

async function applyArbiterRegistered(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const tokenId = numOrNull(evt.args.sbtTokenId)
  await tx.insert(arbiters).values({
    address, registered: true, sbtTokenId: tokenId, trustScore: 0, registeredAt: evt.blockTime,
  }).onConflictDoUpdate({
    target: arbiters.address,
    set: { registered: true, sbtTokenId: tokenId, updatedAt: evt.blockTime },
  })
  await tx.update(users).set({ isArbiter: true, updatedAt: new Date() })
    .where(eq(users.walletAddress, address))
  return null
}

async function applyArbiterDeregistered(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({ registered: false, updatedAt: new Date() }).where(eq(arbiters.address, address))
  await tx.update(users).set({ isArbiter: false, updatedAt: new Date() })
    .where(eq(users.walletAddress, address))
  return null
}

async function applyTrustScore(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const newScore = numOrNull(evt.args.newScore) ?? 0
  const withinSla = Boolean(evt.args.withinSla)
  await tx.update(arbiters).set({
    trustScore: newScore,
    resolutions: sql`${arbiters.resolutions} + 1`,
    resolutionsWithinSla: sql`${arbiters.resolutionsWithinSla} + ${withinSla ? 1 : 0}`,
    resolutionsLate: sql`${arbiters.resolutionsLate} + ${withinSla ? 0 : 1}`,
    updatedAt: new Date(),
  }).where(eq(arbiters.address, address))
  return null
}

function drift(what: string, onchainId: number, txHash: string): null {
  log.warn(`DRIFT: ${what}`, { onchainId, txHash })
  return null
}


