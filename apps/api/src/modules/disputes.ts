/**
 * /disputes — off-chain coordination, on-chain money.
 *
 * Multi-arbiter model (contract v2): opening a dispute writes the reason here
 * and the disputing party locks funds with the payable `openDispute()` tx. The
 * CONTRACT then selects up to 3 random, eligible, non-party arbiters and runs
 * commit-reveal. This module never nominates or assigns arbiters — that model
 * is gone; round state (selected arbiters, phase, deadlines, tally, round
 * index) is read live from the chain on every read, with the indexer mirror
 * as fallback only.
 */
import { desc, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { logger } from '../lib/logger.ts'
import { requireAuth, requireKyc } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { isDisputable } from '../domain/state-machine.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { enqueueDeliveries, writeOutbox } from './notify.ts'
import { disputes, jobs, projectMilestones, projects } from '../db/schema.ts'
import { loadMilestone, requireParticipant } from './helpers.ts'

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
void ADDRESS

export async function openDispute(request: Request, projectId: string, milestoneId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  const { milestone } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (!isDisputable(milestone.chainStatus)) {
    throw Errors.conflict('milestone_not_disputable', `Milestone is ${milestone.chainStatus}; disputes require funded or submitted`)
  }
  // Money truth lives on-chain: confirm the mirror before writing the off-chain row.
  if (milestone.onchainId !== null && getChainAdapter().mode === 'real') {
    const live = await getChainAdapter().getMilestoneStatus(milestone.onchainId).catch(() => null)
    if (live && !isDisputable(live)) {
      throw Errors.conflict('milestone_not_disputable', `Chain says ${live}; disputes require funded or submitted`)
    }
  }

  // Idempotent: the off-chain row is written BEFORE the wallet's on-chain tx
  // lands. If that tx reverted or was never sent, the row is a zombie — a
  // 409 here would brick the retry forever (offchainThenChain aborts before
  // the chain call). Return the existing row so the opener can retry the
  // on-chain open; a duplicate on-chain open reverts harmlessly
  // (NotDisputable) once the first tx has landed.
  const [already] = await getDb().select().from(disputes)
    .where(eq(disputes.milestoneId, milestone.id)).limit(1)
  const body = await validate(request, z.object({ reason: z.string().min(10).max(4000) }).strict())
  if (already) {
    logger.info('dispute open retried — returning existing row', { disputeId: already.id, milestoneId: milestone.id })
    return { ...already, onchainActionRequired: 'openDispute', onchainId: milestone.onchainId }
  }

  // The dispute row and its notification are ONE write. They used to be a
  // separate commit each, which loses the notification permanently: a transient
  // failure between them leaves a dispute nobody was told about, and the retry
  // path above returns the existing row WITHOUT re-emitting, so it never
  // recovers. `writeOutbox(tx, …)` is the existing transaction-bound API
  // (see chain/indexer.ts) — enqueue after commit, never inside the tx.
  const [dispute, deliveryIds] = await getDb().transaction(async (tx) => {
    const [row] = await tx.insert(disputes).values({
      milestoneId: milestone.id,
      projectId: project.id,
      openedById: user.id,
      reason: body.reason,
      // Clocks come from the on-chain round (indexer mirror + live overlay).
    }).returning()
    const ids = await writeOutbox(tx, {
      type: 'dispute.opened',
      actorAddress: user.walletAddress,
      projectId: project.id,
      milestoneId: milestone.id,
      payload: { reason: body.reason, milestoneTitle: milestone.title, disputeId: row!.id },
    })
    return [row, ids] as const
  })
  await enqueueDeliveries(deliveryIds)

  return { ...dispute, onchainActionRequired: 'openDispute', onchainId: milestone.onchainId }
}

/**
 * Discard a zombie dispute record: the off-chain row was written but the
 * opener's wallet tx never landed, so no round exists. Only when the
 * milestone is still disputable on the mirror AND (real mode) live on-chain —
 * deleting after the open landed would orphan the round mirror. Either party
 * may discard (no money moved); re-posting recreates the record.
 */
export async function discardDispute(request: Request, projectId: string, milestoneId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  const { milestone } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  const db = getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.milestoneId, milestone.id)).limit(1)
  if (!dispute || dispute.status !== 'open' || dispute.finalized) throw Errors.notFound('Dispute')
  if (!isDisputable(milestone.chainStatus)) {
    throw Errors.conflict('dispute_on_chain', `Round exists on-chain (milestone is ${milestone.chainStatus}); discarding would orphan it`)
  }
  if (milestone.onchainId !== null && getChainAdapter().mode === 'real') {
    const live = await getChainAdapter().getMilestoneStatus(milestone.onchainId).catch(() => null)
    if (live && !isDisputable(live)) {
      throw Errors.conflict('dispute_on_chain', `Chain says ${live}; discarding would orphan the round`)
    }
  }
  await db.delete(disputes).where(eq(disputes.id, dispute.id))
  return { discarded: true, disputeId: dispute.id }
}

export async function listDisputes(request: Request) {
  const user = await requireAuth(request)
  const db = getDb()
  const rows: DisputeRow[] = (await db.select().from(disputes).orderBy(desc(disputes.createdAt)).limit(200))
    .map((d) => ({ ...d, onchainId: null }))
  // Live first: a newly-selected arbiter must see the dispute even when the
  // indexer mirror hasn't caught up — filter on the overlaid selection, not
  // the stale cache. Costs one getRound per open dispute; failures keep the
  // mirror, so worst case this degrades to the old behavior.
  await overlayRounds(rows)
  // Participants AND arbiters assigned to a round can see the dispute.
  const userProjects = await db.select({ id: projects.id }).from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
  const ids = new Set(userProjects.map((p) => p.id))
  // Seated fallback: a locked project arbiter sees open disputes on that
  // project even when the round mirror is empty (indexer lag / overlay miss).
  // Voting stays chain-gated (`NotSelectedArbiter` reverts), so this only
  // affects visibility, never who can vote.
  const me = user.walletAddress.toLowerCase()
  const openProjectIds = [...new Set(rows.filter((d) => d.status !== 'resolved').map((d) => d.projectId))]
  let seated = new Set<string>()
  if (openProjectIds.length > 0) {
    const seatRows = await db.select({ id: projects.id, chosenArbiters: projects.chosenArbiters })
      .from(projects).where(inArray(projects.id, openProjectIds))
    seated = new Set(seatRows
      .filter((p) => asStrings(p.chosenArbiters).some((a) => a.toLowerCase() === me))
      .map((p) => p.id))
  }
  const visible = rows.filter((d) => ids.has(d.projectId) || seated.has(d.projectId) || selectedIncludes(d, user.walletAddress))
  return withProjectNames(visible)
}

/**
 * Attach the job title as `projectName` so non-participant arbiters can name
 * a dispute without project-list access (their /projects list is empty).
 */
async function withProjectNames<T extends { projectId: string }>(rows: T[]): Promise<(T & { projectName: string | null })[]> {
  if (rows.length === 0) return []
  const db = getDb()
  const pids = [...new Set(rows.map((d) => d.projectId))]
  const prows = await db.select({ id: projects.id, jobId: projects.jobId }).from(projects).where(inArray(projects.id, pids))
  const jobByProject = new Map(prows.map((p) => [p.id, p.jobId]))
  const jids = [...new Set(prows.map((p) => p.jobId))]
  const jrows = jids.length
    ? await db.select({ id: jobs.id, title: jobs.title }).from(jobs).where(inArray(jobs.id, jids))
    : []
  const titleByJob = new Map(jrows.map((j) => [j.id, j.title]))
  return rows.map((d) => ({ ...d, projectName: titleByJob.get(jobByProject.get(d.projectId) ?? '') ?? null }))
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function selectedIncludes(d: { selectedArbiters: unknown }, address: string): boolean {
  const list = Array.isArray(d.selectedArbiters) ? (d.selectedArbiters as string[]) : []
  return list.some((a) => a.toLowerCase() === address.toLowerCase())
}

export async function getDispute(request: Request, disputeId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1)
  if (!row) throw Errors.notFound('Dispute')
  const dispute: DisputeRow = { ...row, onchainId: null }
  await overlayRounds([dispute])
  // Parties always; selected arbiters too (mirrors listDisputes — they vote via commit/reveal).
  if (selectedIncludes(dispute, user.walletAddress)) return (await withProjectNames([dispute]))[0]!
  // Seated fallback (same as listDisputes): a locked project arbiter may fetch
  // while the round mirror is empty; voting stays chain-gated.
  if (dispute.status !== 'resolved') {
    const [p] = await db.select({ chosenArbiters: projects.chosenArbiters })
      .from(projects).where(eq(projects.id, dispute.projectId)).limit(1)
    const me = user.walletAddress.toLowerCase()
    if (p && asStrings(p.chosenArbiters).some((a) => a.toLowerCase() === me)) return (await withProjectNames([dispute]))[0]!
  }
  await requireParticipant(dispute.projectId, user)
  return (await withProjectNames([dispute]))[0]!
}

/**
 * A dispute row plus the milestone's on-chain id.
 *
 * The id rides on the view because it is the ONLY handle a caller needs to
 * reach the round: `Escrow` addresses every dispute call by `milestoneId` and
 * nothing else. Without it the client had to find the milestone through
 * `GET /projects`, which is scoped to the viewer's OWN projects — so an arbiter
 * (who is in none) got `undefined` and every round-gated control on the arbiter
 * queue silently vanished. See `overlayRounds`.
 */
export type DisputeRow = typeof disputes.$inferSelect & { onchainId: number | null }

/**
 * On-chain round overlay: resolved rows are final, so only live-read open
 * disputes; failures keep the mirror. The round index itself is chain truth
 * (appeals bump it, and the mirror can lag), so it is read live first and the
 * round read targets the live round — never a stale mirror. Selected list,
 * phase, deadlines and tally come from `getRound`, never from the cache.
 * Committed/revealed address lists have no contract view (only counts exist
 * on-chain), so those two columns stay indexer-derived by design.
 *
 * The milestone lookup is one batched query for the whole page, and it runs in
 * mock mode too: `onchainId` is a fact about the row, not about the chain, and
 * every client control is gated on it.
 */
async function overlayRounds(rows: DisputeRow[]) {
  if (rows.length === 0) return
  const db = getDb()
  const mids = [...new Set(rows.map((d) => d.milestoneId))]
  const byMilestone = new Map((await db.select({ id: projectMilestones.id, onchainId: projectMilestones.onchainId })
    .from(projectMilestones).where(inArray(projectMilestones.id, mids)))
    .map((m) => [m.id, m.onchainId]))
  for (const d of rows) d.onchainId = byMilestone.get(d.milestoneId) ?? null

  const open = rows.filter((d) => d.status !== 'resolved')
  if (open.length === 0) return
  const adapter = getChainAdapter()
  if (adapter.mode !== 'real') return
  await Promise.all(open.map(async (d) => {
    const onchainId = d.onchainId
    if (onchainId === null) return
    const mirrorRound = d.round
    const meta = await adapter.getDisputeMeta(onchainId).catch(() => null)
    if (meta) {
      d.round = meta.round
      d.appealCount = meta.appealCount
    }
    // Try the live round first, then the mirror round: if the meta read failed
    // the mirror index may be the fresh one (or vice versa). Either live hit
    // wins over the cache; a total miss keeps the mirror and logs, so the
    // seated fallback in listDisputes still surfaces the dispute to voters.
    let live = await adapter.getDisputeRound(onchainId, d.round).catch(() => null)
    if (!live && d.round !== mirrorRound) {
      live = await adapter.getDisputeRound(onchainId, mirrorRound).catch(() => null)
      if (live) d.round = mirrorRound
    }
    if (!live) {
      if (asStrings(d.selectedArbiters).length === 0) {
        logger.warn('dispute overlay miss — arbiter visibility degraded to mirror', {
          disputeId: d.id, onchainId, round: d.round,
        })
      }
      return
    }
    d.selectedArbiters = live.arbiters
    const now = Math.floor(Date.now() / 1000)
    d.phase = live.resolved ? 'resolved' : (now < live.commitDeadline ? 'commit' : 'reveal')
    d.commitDeadline = new Date(live.commitDeadline * 1000)
    d.revealDeadline = new Date(live.revealDeadline * 1000)
    d.tally = { ...(d.tally as Record<string, unknown> ?? {}), [String(d.round)]: live.tally }
  }))
}

/**
 * Whether `address` is one of the arbiters selected for the current round —
 * the indexer-maintained list the frontend uses to gate the commit/reveal UI.
 */
export function isSelectedArbiter(dispute: { selectedArbiters: unknown }, address: string | null | undefined): boolean {
  if (!address) return false
  return selectedIncludes(dispute, address)
}
