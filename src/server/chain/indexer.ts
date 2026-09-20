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
import { getDb, type Db } from '../db'
import { logger } from '../lib/logger'
import { getKv } from '../lib/kv'
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
      await (getDb()).transaction(async (tx) => {
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
    case 'ArbitersSelected': return applyArbitersSelected(tx, evt)
    case 'VoteCommitted': return applyVoteCommitted(tx, evt)
    case 'VoteRevealed': return applyVoteRevealed(tx, evt)
    case 'DisputeResolved': return applyDisputeResolved(tx, evt)
    case 'DisputeFinalized': return applyDisputeFinalized(tx, evt)
    case 'NoQuorumFallback': return applyNoQuorumFallback(tx, evt)
    case 'AppealOpened': return applyAppealOpened(tx, evt)
    case 'AppealResolved': return applyAppealResolved(tx, evt)
    case 'ArbiterRewarded':
    case 'ArbiterPenalized': return null // ledger-only; scores mirror via TrustScoreUpdated
    case 'FeeWithdrawn': return null // ledger-only
    case 'ArbiterRegistered': return applyArbiterRegistered(tx, evt)
    case 'ArbiterDeregistered': return applyArbiterDeregistered(tx, evt)
    case 'TrustScoreUpdated': return applyTrustScore(tx, evt)
    case 'ScoreChanged': return applyScoreChanged(tx, evt)
    case 'StakeDeposited': return applyStakeDeposited(tx, evt)
    case 'StakeWithdrawn': return applyStakeWithdrawn(tx, evt)
    case 'StakeLocked': return applyStakeLocked(tx, evt)
    case 'StakeSlashed': return applyStakeSlashed(tx, evt)
    case 'UnstakeRequested': return applyUnstakeRequested(tx, evt)
    case 'UnstakeCancelled': return applyUnstakeCancelled(tx, evt)
    case 'TierThresholdsUpdated': return applyTierThresholds(tx, evt)
    case 'MinStakeUpdated':
    case 'MinScoreToWithdrawUpdated': return null // config mirrors via env; no per-arbiter row change
    case 'MinStakeDurationUpdated': return applyMinStakeDuration(tx, evt)
    case 'UnstakeCooldownUpdated': return applyUnstakeCooldown(tx, evt)
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

// ── Multi-arbiter dispute round mirror ──────────────────────────────────────

/** Load the dispute row by on-chain milestone id. */
async function loadDisputeByOnchainId(tx: Tx, onchainId: number) {
  const m = await loadMilestoneByOnchainId(tx, onchainId)
  if (!m) return { milestone: null, dispute: null } as const
  const [dispute] = await tx.select().from(disputes).where(eq(disputes.milestoneId, m.id)).limit(1)
  return { milestone: m, dispute: dispute ?? null } as const
}

const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : [])
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).toLowerCase()).filter((x) => x !== '0x0000000000000000000000000000000000000000') : []

async function applyArbitersSelected(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { milestone, dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!milestone || !dispute) return drift('ArbitersSelected', numOrNull(evt.args.milestoneId)!, evt.txHash)
  const round = numOrNull(evt.args.round) ?? 0
  const arbiters = strArr(evt.args.arbiters).slice(0, numOrNull(evt.args.count) ?? 3)
  // Events carry no timestamps — derive deadlines like the contract:
  // commitDeadline = block + commitWindow, reveal = commit + revealWindow.
  const commitMs = evt.blockTime.getTime() + env.COMMIT_WINDOW_SECONDS * 1000
  const revealMs = commitMs + env.REVEAL_WINDOW_SECONDS * 1000
  await tx.update(disputes).set({
    phase: 'commit',
    round,
    selectedArbiters: arbiters,
    committedArbiters: [],
    revealedArbiters: [],
    commitDeadline: new Date(commitMs),
    revealDeadline: new Date(revealMs),
    updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return null
}

async function applyVoteCommitted(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!dispute) return drift('VoteCommitted', numOrNull(evt.args.milestoneId)!, evt.txHash)
  const who = str(evt.args.arbiter).toLowerCase()
  const list = new Set<string>([...strArr(dispute.committedArbiters), who])
  await tx.update(disputes).set({ committedArbiters: [...list], updatedAt: evt.blockTime })
    .where(eq(disputes.id, dispute.id))
  return null
}

async function applyVoteRevealed(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!dispute) return drift('VoteRevealed', numOrNull(evt.args.milestoneId)!, evt.txHash)
  const who = str(evt.args.arbiter).toLowerCase()
  const list = new Set<string>([...strArr(dispute.revealedArbiters), who])
  const tally = (dispute.tally as Record<string, number[]>) ?? {}
  const roundKey = String(numOrNull(evt.args.round) ?? 0)
  const counts = tally[roundKey] ?? [0, 0, 0]
  counts[Number(evt.args.outcome) || 0] = (counts[Number(evt.args.outcome) || 0] ?? 0) + 1
  tally[roundKey] = counts
  await tx.update(disputes).set({
    revealedArbiters: [...list], tally, phase: 'reveal', updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return null
}

async function applyDisputeFinalized(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { milestone, dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!milestone || !dispute) return drift('DisputeFinalized', numOrNull(evt.args.milestoneId)!, evt.txHash)
  const outcome = outcomeFromUint8(Number(evt.args.outcome))
  const quorumMet = Boolean(evt.args.quorumMet)
  // The winners are the revealed arbiters whose vote equals the outcome — we
  // can approximate majority membership from the tally only, so we record the
  // round outcome here and let DisputeResolved stamp the representative.
  await tx.update(disputes).set({
    phase: 'resolved',
    outcome,
    finalized: quorumMet && outcome !== undefined,
    finalizedAt: evt.blockTime,
    updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return {
    type: 'dispute.finalized',
    actorAddress: null,
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    payload: { outcome, quorumMet, txHash: evt.txHash },
  }
}

async function applyNoQuorumFallback(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { milestone, dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!milestone || !dispute) return drift('NoQuorumFallback', numOrNull(evt.args.milestoneId)!, evt.txHash)
  await tx.update(disputes).set({
    phase: 'resolved', finalized: false, updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return {
    type: 'dispute.no_quorum',
    actorAddress: str(evt.args.opener).toLowerCase(),
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    payload: { refunded: str(evt.args.refunded), txHash: evt.txHash },
  }
}

async function applyAppealOpened(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!dispute) return drift('AppealOpened', numOrNull(evt.args.milestoneId)!, evt.txHash)
  await tx.update(disputes).set({
    round: numOrNull(evt.args.newRound) ?? dispute.round + 1,
    appealCount: dispute.appealCount + 1,
    status: 'open',
    finalized: false,
    updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return null
}

async function applyAppealResolved(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!dispute) return drift('AppealResolved', numOrNull(evt.args.milestoneId)!, evt.txHash)
  await tx.update(disputes).set({ updatedAt: evt.blockTime }).where(eq(disputes.id, dispute.id))
  return null
}

// ── Registry staking + score mirror ─────────────────────────────────────────

function tierForSync(stakeWei: string, registered: boolean, silverWei: string, goldWei: string): number {
  if (!registered) return 0
  let stake = 0n
  try { stake = BigInt(stakeWei || '0') } catch { stake = 0n }
  const min = BigInt(env.MIN_STAKE_WEI)
  if (stake < min) return 0
  try {
    if (BigInt(goldWei) > 0n && stake >= BigInt(goldWei)) return 3
    if (BigInt(silverWei) > 0n && stake >= BigInt(silverWei)) return 2
  } catch { /* malformed threshold → bronze fallback */ }
  return 1
}

async function currentThresholds(): Promise<{ silver: string; gold: string }> {
  const min = BigInt(env.MIN_STAKE_WEI)
  try {
    const kv = await getKv()
    const [s, g] = await Promise.all([kv.get('registry:tierSilver'), kv.get('registry:tierGold')])
    return { silver: s ?? (min * 2n).toString(), gold: g ?? (min * 5n).toString() }
  } catch {
    return { silver: (min * 2n).toString(), gold: (min * 5n).toString() }
  }
}

async function syncUserArbiter(tx: Tx, address: string, stakeWei: string, registered: boolean) {
  const { silver, gold } = await currentThresholds()
  await tx.update(users).set({
    isArbiter: registered,
    arbiterTier: tierForSync(stakeWei, registered, silver, gold),
    updatedAt: new Date(),
  }).where(eq(users.walletAddress, address))
}

async function applyScoreChanged(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const newScore = numOrNull(evt.args.newScore) ?? 0
  const reason = numOrNull(evt.args.reason) ?? 0
  const locked = newScore < env.MIN_SCORE_TO_WITHDRAW
  await tx.update(arbiters).set({
    trustScore: newScore,
    locked,
    resolutions: sql`${arbiters.resolutions} + 1`,
    resolutionsWithinSla: sql`${arbiters.resolutionsWithinSla} + ${reason === 1 ? 1 : 0}`,
    resolutionsLate: sql`${arbiters.resolutionsLate} + ${reason === 3 ? 1 : 0}`,
    updatedAt: new Date(),
  }).where(eq(arbiters.address, address))
  return null
}

async function applyStakeDeposited(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const total = str(evt.args.totalStake)
  // _enroll emits Registered + Deposited in one tx; either order must converge.
  // New rows start at MAX_SCORE (100) — never the 0 column default.
  await tx.insert(arbiters).values({
    address, registered: true, stakeWei: total, trustScore: 100, registeredAt: evt.blockTime,
  }).onConflictDoUpdate({
    target: arbiters.address,
    set: { stakeWei: total, registered: true, updatedAt: evt.blockTime },
  })
  await syncUserArbiter(tx, address, total, true)
  return null
}

async function applyStakeWithdrawn(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({
    stakeWei: '0', registered: false, unstakeRequested: false, locked: false, updatedAt: evt.blockTime,
  }).where(eq(arbiters.address, address))
  await syncUserArbiter(tx, address, '0', false)
  return null
}

async function applyStakeLocked(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({ locked: true, updatedAt: evt.blockTime }).where(eq(arbiters.address, address))
  return null
}

async function applyStakeSlashed(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({
    stakeWei: '0', registered: false, locked: false, updatedAt: evt.blockTime,
  }).where(eq(arbiters.address, address))
  await syncUserArbiter(tx, address, '0', false)
  return null
}

async function applyUnstakeRequested(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  // Benched from selection immediately; withdrawal needs no further wait (the
  // cooldown gates the request itself) — unstakeReadyAt is already past.
  await tx.update(arbiters).set({ unstakeRequested: true, updatedAt: evt.blockTime }).where(eq(arbiters.address, address))
  return null
}

async function applyUnstakeCancelled(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({ unstakeRequested: false, updatedAt: evt.blockTime }).where(eq(arbiters.address, address))
  return null
}

async function applyArbiterRegistered(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const tokenId = numOrNull(evt.args.sbtTokenId)
  // New arbiters start at the maximum trust score (ArbiterRegistry._enroll sets
  // `trustScore = MAX_SCORE` with no event), so seed the mirror at 100 to match
  // the chain — otherwise the panel shows 0 until the first dispute.
  // StakeDeposited (same tx) carries the collateral; preserve it when present.
  const [existing] = await tx.select({ stakeWei: arbiters.stakeWei, trustScore: arbiters.trustScore }).from(arbiters).where(eq(arbiters.address, address)).limit(1)
  const stakeWei = existing?.stakeWei ?? '0'
  await tx.insert(arbiters).values({
    address, registered: true, sbtTokenId: tokenId, trustScore: 100, stakeWei, registeredAt: evt.blockTime,
  }).onConflictDoUpdate({
    target: arbiters.address,
    set: {
      registered: true, sbtTokenId: tokenId,
      trustScore: existing && existing.trustScore > 0 ? existing.trustScore : 100,
      registeredAt: evt.blockTime, updatedAt: evt.blockTime,
    },
  })
  await syncUserArbiter(tx, address, stakeWei, true)
  return null
}

async function applyArbiterDeregistered(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  await tx.update(arbiters).set({ registered: false, updatedAt: new Date() }).where(eq(arbiters.address, address))
  const [row] = await tx.select({ stakeWei: arbiters.stakeWei }).from(arbiters).where(eq(arbiters.address, address)).limit(1)
  await syncUserArbiter(tx, address, row?.stakeWei ?? '0', false)
  return null
}

async function applyTrustScore(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const address = str(evt.args.arbiter).toLowerCase()
  const newScore = numOrNull(evt.args.newScore) ?? 0
  const withinSla = Boolean(evt.args.withinSla)
  await tx.update(arbiters).set({
    trustScore: newScore,
    locked: newScore < env.MIN_SCORE_TO_WITHDRAW,
    resolutions: sql`${arbiters.resolutions} + 1`,
    resolutionsWithinSla: sql`${arbiters.resolutionsWithinSla} + ${withinSla ? 1 : 0}`,
    resolutionsLate: sql`${arbiters.resolutionsLate} + ${withinSla ? 0 : 1}`,
    updatedAt: new Date(),
  }).where(eq(arbiters.address, address))
  return null
}

async function applyTierThresholds(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  // setTierThresholds(silver, gold) — persist so tierFor stays in sync with tierOf.
  const silver = str(evt.args.silverStake ?? evt.args.silver ?? '')
  const gold = str(evt.args.goldStake ?? evt.args.gold ?? '')
  try {
    const kv = await getKv()
    if (silver && BigInt(silver) >= 0n) await kv.set('registry:tierSilver', silver)
    if (gold && BigInt(gold) >= 0n) await kv.set('registry:tierGold', gold)
  } catch (err) {
    log.warn('TierThresholdsUpdated KV persist failed', { err: String(err) })
  }
  // Recompute every user's tier with the new floors (stake mirrors are unchanged).
  try {
    const rows = await tx.select({ address: arbiters.address, stakeWei: arbiters.stakeWei, registered: arbiters.registered }).from(arbiters)
    const { silver: s, gold: g } = await currentThresholds()
    for (const r of rows) {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.walletAddress, r.address)).limit(1)
      if (!u) continue
      await tx.update(users).set({
        arbiterTier: tierForSync(r.stakeWei, r.registered, s, g),
        updatedAt: new Date(),
      }).where(eq(users.id, u.id))
    }
  } catch (err) {
    log.warn('TierThresholdsUpdated user resync failed', { err: String(err) })
  }
  return null
}

async function applyMinStakeDuration(_tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  // setMinStakeDuration(newSeconds) — persist so eligible mirrors the chain clock.
  const v = str(evt.args.newSeconds ?? evt.args.minStakeDuration ?? '')
  try {
    if (v !== '') await (await getKv()).set('registry:minStakeDuration', v)
  } catch (err) {
    log.warn('MinStakeDurationUpdated KV persist failed', { err: String(err) })
  }
  return null
}

async function applyUnstakeCooldown(_tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const v = str(evt.args.newSeconds ?? evt.args.unstakeCooldown ?? '')
  try {
    if (v !== '') await (await getKv()).set('registry:unstakeCooldown', v)
  } catch (err) {
    log.warn('UnstakeCooldownUpdated KV persist failed', { err: String(err) })
  }
  return null
}

function drift(what: string, onchainId: number, txHash: string): null {
  log.warn(`DRIFT: ${what}`, { onchainId, txHash })
  return null
}


