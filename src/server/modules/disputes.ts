/**
 * /disputes (PRD F10) — off-chain coordination, on-chain money.
 *
 * Opening a dispute: the record (reason + coordination state) is written here
 * and the disputing party locks funds with the on-chain dispute() tx; the
 * indexer confirms the flip. Arbiter selection: each side proposes a
 * registered arbiter; matching proposals = agreed. If the 48h window lapses
 * without agreement, the platform admin may assign one.
 */
import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAdmin, requireAuth } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isDisputable } from '../domain/state-machine'
import { emitNotification } from './notify'
import { arbiters, disputes, projects } from '../db/schema'
import { loadMilestone, requireParticipant } from './helpers'

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

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
    agreementDeadline: new Date(Date.now() + env.ARBITER_AGREEMENT_WINDOW_HOURS * 3600_000),
  }).returning()

  await emitNotification({
    type: 'dispute.opened',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { reason: body.reason, milestoneTitle: milestone.title, disputeId: dispute!.id },
  })
  return { ...dispute, onchainActionRequired: 'dispute', onchainId: milestone.onchainId }
}

export async function listDisputes(request: Request) {
  const user = await requireAuth(request)
  const db = getDb()
  const userProjects = await db.select({ id: projects.id }).from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
  const ids = new Set(userProjects.map((p) => p.id))
  const rows = await db.select().from(disputes).orderBy(desc(disputes.createdAt)).limit(200)
  return rows.filter((d) => ids.has(d.projectId))
}

export async function getDispute(request: Request, disputeId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  await requireParticipant(dispute.projectId, user)
  return dispute
}

/** Each party names a registered arbiter; a match = mutual agreement. */
export async function proposeArbiter(request: Request, disputeId: string) {
  const user = await requireAuth(request)
  const db = getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  const [project] = await db.select().from(projects).where(eq(projects.id, dispute.projectId)).limit(1)
  if (!project) throw Errors.notFound('Project')
  if (project.clientId !== user.id && project.freelancerId !== user.id) throw Errors.forbidden('Participants only')
  if (dispute.status === 'resolved') throw Errors.conflict('dispute_resolved', 'Dispute already resolved')

  const body = await validate(request, z.object({ arbiterAddress: ADDRESS }).strict())
  const arbiter = body.arbiterAddress.toLowerCase()
  const [reg] = await db.select().from(arbiters).where(eq(arbiters.address, arbiter)).limit(1)
  if (!reg?.registered) throw Errors.badRequest('arbiter_not_registered', 'That address is not a registered arbiter')

  const patch = project.clientId === user.id
    ? { clientProposedArbiter: arbiter }
    : { freelancerProposedArbiter: arbiter }
  const agreed = dispute.clientProposedArbiter === arbiter || dispute.freelancerProposedArbiter === arbiter
    ? (project.clientId === user.id
      ? dispute.freelancerProposedArbiter === arbiter
      : dispute.clientProposedArbiter === arbiter)
    : false

  const [updated] = await db.update(disputes).set({
    ...patch,
    ...(dispute.status === 'assigned' ? {} : agreed ? { status: 'agreed' as const, agreedArbiter: arbiter } : {}),
    updatedAt: new Date(),
  }).where(eq(disputes.id, dispute.id)).returning()

  if (agreed && updated!.status === 'agreed') {
    await emitNotification({
      type: 'dispute.arbiter_agreed',
      actorAddress: user.walletAddress,
      projectId: dispute.projectId,
      milestoneId: dispute.milestoneId,
      payload: { disputeId: dispute.id, arbiter },
    })
  }
  return updated
}

/** Admin assigns an arbiter — only after the 48h agreement window lapses. */
export async function assignArbiter(request: Request, disputeId: string) {
  await requireAdmin(request)
  const db = getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  if (dispute.status === 'resolved') throw Errors.conflict('dispute_resolved', 'Dispute already resolved')
  if (dispute.status === 'agreed') throw Errors.conflict('dispute_agreed', 'Parties already agreed on an arbiter')
  if (Date.now() < dispute.agreementDeadline.getTime()) {
    throw Errors.precondition('window_open', `Agreement window is still open until ${dispute.agreementDeadline.toISOString()}`)
  }

  const body = await validate(request, z.object({ arbiterAddress: ADDRESS }).strict())
  const arbiter = body.arbiterAddress.toLowerCase()
  const [reg] = await db.select().from(arbiters).where(eq(arbiters.address, arbiter)).limit(1)
  if (!reg?.registered) throw Errors.badRequest('arbiter_not_registered', 'That address is not a registered arbiter')

  const [updated] = await db.update(disputes).set({
    adminAssignedArbiter: arbiter, status: 'assigned', updatedAt: new Date(),
  }).where(eq(disputes.id, dispute.id)).returning()

  await emitNotification({
    type: 'dispute.arbiter_assigned',
    actorAddress: null,
    projectId: dispute.projectId,
    milestoneId: dispute.milestoneId,
    payload: { disputeId: dispute.id, arbiter },
  })
  return updated
}
