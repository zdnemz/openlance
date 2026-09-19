/**
 * /disputes — off-chain coordination, on-chain money.
 *
 * Multi-arbiter model (contract v2): opening a dispute writes the reason here
 * and the disputing party locks funds with the payable `openDispute()` tx. The
 * CONTRACT then selects up to 3 random, eligible, non-party arbiters and runs
 * commit-reveal. This module never nominates or assigns arbiters — that model
 * is gone; the indexer mirrors the on-chain round (selected arbiters, phase,
 * deadlines, tally) into the `disputes` row for the UI to read.
 */
import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isDisputable } from '../domain/state-machine'
import { emitNotification } from './notify'
import { disputes, projects } from '../db/schema'
import { loadMilestone, requireParticipant } from './helpers'

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
void ADDRESS

export async function openDispute(request: Request, projectId: string, milestoneId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const { milestone } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (!isDisputable(milestone.chainStatus)) {
    throw Errors.conflict('milestone_not_disputable', `Milestone is ${milestone.chainStatus}; disputes require funded or submitted`)
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
    // Kept populated for schema compatibility; the real clocks come from the
    // on-chain round and are mirrored by the indexer.
    agreementDeadline: new Date(Date.now() + env.ARBITER_AGREEMENT_WINDOW_HOURS * 3600_000),
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
  // Participants AND arbiters assigned to a round can see the dispute.
  const userProjects = await db.select({ id: projects.id }).from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
  const ids = new Set(userProjects.map((p) => p.id))
  const rows = await db.select().from(disputes).orderBy(desc(disputes.createdAt)).limit(200)
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
  await requireParticipant(dispute.projectId, user)
  return dispute
}

/**
 * Whether `address` is one of the arbiters selected for the current round —
 * the indexer-maintained list the frontend uses to gate the commit/reveal UI.
 */
export function isSelectedArbiter(dispute: { selectedArbiters: unknown }, address: string | null | undefined): boolean {
  if (!address) return false
  return selectedIncludes(dispute, address)
}
