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
import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isDisputable } from '../domain/state-machine'
import { getChainAdapter } from '../chain/adapter'
import { emitNotification } from './notify'
import { disputes, projectMilestones, projects } from '../db/schema'
import { loadMilestone, requireParticipant } from './helpers'

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

  const existing = await getDb().select({ id: disputes.id }).from(disputes)
    .where(eq(disputes.milestoneId, milestone.id)).limit(1)
  if (existing.length) throw Errors.conflict('dispute_exists', 'This milestone already has a dispute')

  const body = await validate(request, z.object({ reason: z.string().min(10).max(4000) }).strict())
  const db = getDb()
  const [dispute] = await db.insert(disputes).values({
    milestoneId: milestone.id,
    projectId: project.id,
    openedById: user.id,
    reason: body.reason,
    // Clocks come from the on-chain round (indexer mirror + live overlay).
  }).returning()

  await emitNotification({
    type: 'dispute.opened',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { reason: body.reason, milestoneTitle: milestone.title, disputeId: dispute!.id },
  })
  return { ...dispute, onchainActionRequired: 'openDispute', onchainId: milestone.onchainId }
}

export async function listDisputes(request: Request) {
  const user = await requireAuth(request)
  const db = getDb()
  const rows = await db.select().from(disputes).orderBy(desc(disputes.createdAt)).limit(200)
  // Live first: a newly-selected arbiter must see the dispute even when the
  // indexer mirror hasn't caught up — filter on the overlaid selection, not
  // the stale cache. Costs one getRound per open dispute; failures keep the
  // mirror, so worst case this degrades to the old behavior.
  await overlayRounds(rows)
  // Participants AND arbiters assigned to a round can see the dispute.
  const userProjects = await db.select({ id: projects.id }).from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
  const ids = new Set(userProjects.map((p) => p.id))
  return rows.filter((d) => ids.has(d.projectId) || selectedIncludes(d, user.walletAddress))
}

function selectedIncludes(d: { selectedArbiters: unknown }, address: string): boolean {
  const list = Array.isArray(d.selectedArbiters) ? (d.selectedArbiters as string[]) : []
  return list.some((a) => a.toLowerCase() === address.toLowerCase())
}

export async function getDispute(request: Request, disputeId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  await overlayRounds([dispute])
  // Parties always; selected arbiters too (mirrors listDisputes — they vote via commit/reveal).
  if (selectedIncludes(dispute, user.walletAddress)) return dispute
  await requireParticipant(dispute.projectId, user)
  return dispute
}

/**
 * On-chain round overlay: resolved rows are final, so only live-read open
 * disputes; failures keep the mirror. The round index itself is chain truth
 * (appeals bump it, and the mirror can lag), so it is read live first and the
 * round read targets the live round — never a stale mirror. Selected list,
 * phase, deadlines and tally come from `getRound`, never from the cache.
 * Committed/revealed address lists have no contract view (only counts exist
 * on-chain), so those two columns stay indexer-derived by design.
 */
async function overlayRounds(rows: (typeof disputes.$inferSelect)[]) {
  const open = rows.filter((d) => d.status !== 'resolved')
  if (open.length === 0) return
  const adapter = getChainAdapter()
  if (adapter.mode !== 'real') return
  const db = getDb()
  await Promise.all(open.map(async (d) => {
    const [m] = await db.select({ onchainId: projectMilestones.onchainId }).from(projectMilestones)
      .where(eq(projectMilestones.id, d.milestoneId)).limit(1)
    if (!m?.onchainId) return
    const meta = await adapter.getDisputeMeta(m.onchainId).catch(() => null)
    if (meta) {
      d.round = meta.round
      d.appealCount = meta.appealCount
    }
    const live = await adapter.getDisputeRound(m.onchainId, d.round).catch(() => null)
    if (!live) return
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
