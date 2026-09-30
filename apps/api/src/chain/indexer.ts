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
import { env } from '../config.ts'
import { getDb, type Db } from '../db/index.ts'
import { logger } from '../lib/logger.ts'
import { invalidate } from '../lib/cache.ts'
import { getKv } from '../lib/kv.ts'
import { getQueues } from '../lib/queue.ts'
import {
  freelancerReceivedValue, isTerminal, nextMilestoneStatus,
} from '../domain/state-machine.ts'
import type { NotificationType } from '../domain/notifications.ts'
import { bytes32ToUuid } from './events.ts'
import type { RawChainLog, EvMilestoneFunded } from './events.ts'
import { outcomeFromUint8 } from './abi.ts'
import {
  disputes, jobs, ledgerEvents, projectMilestones, projects,
  users,
} from '../db/schema.ts'
import { writeOutbox } from '../modules/notify.ts'
import { UNPUBLISHED } from '../modules/jobs.ts'

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
  // The read-model caches (arbiters list, overview) must not outlive the
  // mirror they project: bust them whenever events actually applied, or the
  // UI keeps serving pre-tx rows until the TTL expires.
  if (result.applied > 0) await invalidate('read:arbiters:list', 'read:overview')
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
    case 'ArbiterPenalized': return null // ledger-only; scores live on-chain
    case 'FeeWithdrawn': return null // ledger-only
    case 'BudgetLocked': return null // publish verifies the lock tx directly
    case 'BudgetUnlocked': return applyBudgetUnlocked(tx, evt)
    case 'FundsWithdrawn': return applyWithdrawn(tx, evt)
    // ── Registry events: NO off-chain arbiter table to mirror. Scores, stakes
    //    and the roster are read live from the contract. Only the registry's
    //    *tuning knobs* are cached in KV so tier/eligibility math stays in sync.
    case 'ArbiterRegistered':
    case 'ArbiterDeregistered':
    case 'TrustScoreUpdated':
    case 'ScoreChanged':
    case 'StakeDeposited':
    case 'StakeReduced':
    case 'StakeWithdrawn':
    case 'StakeLocked':
    case 'StakeSlashed':
    case 'UnstakeRequested':
    case 'UnstakeCancelled':
    case 'MinStakeUpdated':
    case 'MinScoreToWithdrawUpdated': return null
    case 'TierThresholdsUpdated': return applyTierThresholds(tx, evt)
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
  // Two rows must never claim one onchain id: `onchain_id` is UNIQUE, and the id
  // is only unique WITHIN a chain — after a redeploy both ids restart at 1. The
  // colliding write used to throw, which rolled back this whole transaction
  // including the ledger row, while the pump advanced the chunk checkpoint
  // anyway (indexer-pump.ts writes it outside the failed transaction). The funding
  // event was then lost permanently and unrecoverable, with the checkpoint
  // claiming it had been indexed.
  //
  // Refusing to write — like the three guards above — keeps the ledger row, which
  // is the recoverable half: the event stays on the record for reconciliation, and
  // resolve-on-write can still find it by ref.
  const onchainId = numOrNull(args.milestoneId)
  if (onchainId !== null) {
    const holder = await loadMilestoneByOnchainId(tx, onchainId)
    if (holder && holder.id !== m.id) {
      log.warn('DRIFT: onchain id already claimed by another milestone', {
        onchainId, ref, claimedBy: holder.id, refRow: m.id, txHash: evt.txHash,
        detail: 'the claiming row belongs to a different chain generation, or two milestones genuinely collided',
      })
      return null
    }
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
  // `viaDisputeResolution` is not a contract arg here: Escrow.sol only ever
  // emits MilestoneSplit from _settleMilestone (finalizeDispute), so a split is
  // always a dispute settlement — and the flag is what pulls the round's
  // arbiters into this row's audience (see resolveRecipients).
  return {
    type: 'milestone.split',
    actorAddress: null,
    projectId: m.projectId,
    milestoneId: m.id,
    payload: { clientAmount: str(evt.args.clientAmount), freelancerAmount, fee, txHash: evt.txHash, projectCompleted: completed, viaDisputeResolution: true },
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

/**
 * Pull receipt: the freelancer withdrew claimable principal. Status is
 * already terminal (Released / Resolved*) — this only stamps the receipt.
 * No stats move here: value was credited at release/split time.
 */
async function applyWithdrawn(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const id = numOrNull(evt.args.milestoneId)!
  const m = await loadMilestoneByOnchainId(tx, id)
  if (!m) return drift('FundsWithdrawn', id, evt.txHash)
  await tx.update(projectMilestones)
    .set({ withdrawnAt: evt.blockTime, withdrawTxHash: evt.txHash, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, m.id))
  return null // the withdrawer's own receipt is the confirmation
}

/**
 * The client pulled the job budget back out of escrow.
 *
 * `publish` is the reason an `open` job is trustworthy: it locks the ceiling, so
 * every job in the marketplace is funded and a bid is never a promise the poster
 * cannot keep. A withdrawal removes that backing, so the job leaves the
 * marketplace and goes back to being a draft — a partial withdrawal counts, since
 * the ceiling is no longer covered either. It comes back as a draft and not a
 * `cancelled`, because the poster may well re-publish it (`lockBudget` accepts a
 * fully spent key again, Escrow.lockBudget).
 *
 * Only `open` moves. `in_progress` means the budget was drawn into milestones
 * and this is the ordinary surplus return after an award, and `cancelled` means
 * the poster already closed it out — neither is a listing the withdrawal
 * invalidates.
 */
async function applyBudgetUnlocked(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const jobId = bytes32ToUuid(str(evt.args.jobRef))
  if (!jobId) return drift('BudgetUnlocked (unmappable jobRef)', str(evt.args.jobRef), evt.txHash)
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  if (!job) return drift('BudgetUnlocked (unknown job)', jobId, evt.txHash)
  if (job.status !== 'open') return null
  // The funding ledger describes the lock that just went away: leaving it set
  // would advertise a deposit this job no longer has, and `publishJob` is the
  // only thing that should ever write those columns.
  await tx.update(jobs).set({ ...UNPUBLISHED, updatedAt: evt.blockTime }).where(eq(jobs.id, job.id))
  return null // the poster withdrew their own money; their wallet is the receipt
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
  // Silent: the settlement itself is the announcement. `finalizeDispute` emits
  // Milestone{Released,Refunded,Split} in this same tx, and that applier
  // notifies both parties AND the round's arbiters (`viaDisputeResolution`) —
  // one row for the settlement instead of two saying the same thing.
  return null
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
  // No quorum: `NoQuorumFallback` fires in the SAME tx, right after this log,
  // and its notification (`dispute.no_quorum`) carries the refund. Emitting
  // here too gave the parties two rows saying the identical thing.
  if (!quorumMet) return null
  return {
    type: 'dispute.finalized',
    actorAddress: null,
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    payload: { outcome, quorumMet, txHash: evt.txHash },
  }
}

/**
 * The round could not decide, so the contract settled it: the opener's dispute fee
 * is refunded AND the whole milestone goes back to the client (`ResolvedRefund`),
 * inside this same `resolveDispute` tx. There is no `finalizeDispute` to follow, so
 * this log is the settlement receipt — the milestone status, its settlement hash and
 * the project-completion check all ride here (the contract emits no `Milestone*`
 * event on this path, and the parties get exactly one inbox row for the action).
 */
async function applyNoQuorumFallback(tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  const { milestone, dispute } = await loadDisputeByOnchainId(tx, numOrNull(evt.args.milestoneId)!)
  if (!milestone || !dispute) return drift('NoQuorumFallback', numOrNull(evt.args.milestoneId)!, evt.txHash)
  const { to, legal } = nextMilestoneStatus(milestone.chainStatus, 'NoQuorumFallback')
  if (!legal) return drift('NoQuorumFallback (illegal from ' + milestone.chainStatus + ')', numOrNull(evt.args.milestoneId)!, evt.txHash)
  await tx.update(projectMilestones).set({ chainStatus: to, updatedAt: evt.blockTime })
    .where(eq(projectMilestones.id, milestone.id))
  await markSettled(tx, milestone.id, evt.txHash, evt.blockTime)
  // No stats move: the client's money came back (no `totalPaidWei` outflow) and the
  // freelancer was paid nothing. The project may now be complete.
  const completed = await completeProjectIfDone(tx, milestone.projectId)
  // `status: 'resolved'` is what takes the dispute out of the open queue and retires
  // every payout control on it — there is nothing left to tally, finalize or appeal.
  // `finalized` stays FALSE: that flag means "a quorum recorded a majority", and no
  // quorum did. `applyDisputeFinalized` set it (and `finalizedAt`) from the same tx.
  await tx.update(disputes).set({
    phase: 'resolved', finalized: false, status: 'resolved', outcome: 'refund',
    resolvedAt: evt.blockTime, resolutionTxHash: evt.txHash, updatedAt: evt.blockTime,
  }).where(eq(disputes.id, dispute.id))
  return {
    type: 'dispute.no_quorum',
    actorAddress: str(evt.args.opener).toLowerCase(),
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    payload: {
      refunded: str(evt.args.refunded), // the opener's dispute fee
      milestoneRefundedWei: milestone.amountWei, // and the milestone, to the client
      projectCompleted: completed,
      txHash: evt.txHash,
    },
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

// ── Registry tuning knobs (KV cache only) ───────────────────────────────────
// Arbiter standing (roster · trust · stake · tier) is NOT mirrored off-chain:
// it is read live from the contract. Only setTierThresholds / setMinStakeDuration
// / setUnstakeCooldown are cached in KV, so tier + eligibility math can stay in
// sync with the chain without an arbiter table.

async function applyTierThresholds(_tx: Tx, evt: RawChainLog): Promise<PlannedNotification | null> {
  // setTierThresholds(silver, gold) — persist so tier math stays in sync with
  // tierOf. There is no per-arbiter row to update; tiers are derived on read.
  const silver = str(evt.args.silverStake ?? evt.args.silver ?? '')
  const gold = str(evt.args.goldStake ?? evt.args.gold ?? '')
  try {
    const kv = await getKv()
    if (silver && BigInt(silver) >= 0n) await kv.set('registry:tierSilver', silver)
    if (gold && BigInt(gold) >= 0n) await kv.set('registry:tierGold', gold)
  } catch (err) {
    log.warn('TierThresholdsUpdated KV persist failed', { err: String(err) })
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

/** A chain event the mirror has no row for. `ref` is an onchain id, or a uuid for job-level events. */
function drift(what: string, ref: number | string, txHash: string): null {
  log.warn(`DRIFT: ${what}`, { ref, txHash })
  return null
}


