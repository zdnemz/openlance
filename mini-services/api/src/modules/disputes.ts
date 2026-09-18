/**
 * /disputes (PRD F10) — off-chain coordination, on-chain money.
 *
 * Opening a dispute: the record (reason + coordination state) is written here
 * and the disputing party locks funds with the on-chain dispute() tx; the
 * indexer confirms the flip. Arbiter selection: each side proposes a
 * registered arbiter; matching proposals = agreed. If the 48h window lapses
 * without agreement, the platform admin may assign one (sla-scan cron pings).
 */
import { Hono } from 'hono'
import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, requireAdmin, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isDisputable } from '../domain/state-machine'
import { emitNotification } from './notify'
import { arbiters, disputes, projects } from '../db/schema'
import { loadMilestone, requireParticipant } from './helpers'

/** Mounted at /projects — opening a dispute on a milestone. */
export const projectDisputeRoutes = new Hono()
/** Mounted at /disputes — listing + arbiter proposals. */
export const disputeRoutes = new Hono()
/** Mounted at /admin — post-window arbiter assignment. */
export const adminDisputeRoutes = new Hono()

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

projectDisputeRoutes.post('/:id/milestones/:mid/disputes', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const { milestone } = await loadMilestone(c.req.param('mid'))
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (!isDisputable(milestone.chainStatus)) {
    throw Errors.conflict('milestone_not_disputable', `Milestone is ${milestone.chainStatus}; disputes require funded or submitted`)
  }

  const existing = await (await getDb()).select({ id: disputes.id }).from(disputes)
    .where(eq(disputes.milestoneId, milestone.id)).limit(1)
  if (existing.length) throw Errors.conflict('dispute_exists', 'This milestone already has a dispute')

  const body = await validate(c, z.object({ reason: z.string().min(10).max(4000) }).strict())
  const db = await getDb()
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
  return ok(c, { ...dispute, onchainActionRequired: 'dispute', onchainId: milestone.onchainId }, 201)
})

disputeRoutes.get('/', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const db = await getDb()
  // disputes for projects the user participates in
  const userProjects = await db.select({ id: projects.id }).from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
  const ids = new Set(userProjects.map((p) => p.id))
  const rows = await db.select().from(disputes).orderBy(desc(disputes.createdAt)).limit(200)
  return ok(c, rows.filter((d) => ids.has(d.projectId)))
})


disputeRoutes.get('/:id', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const db = await getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, c.req.param('id'))).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  const project = await requireParticipant(dispute.projectId, user)
  void project
  return ok(c, dispute)
})

/** Each party names a registered arbiter; a match = mutual agreement. */
disputeRoutes.post('/:id/arbiter-proposal', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const db = await getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, c.req.param('id'))).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  const [project] = await db.select().from(projects).where(eq(projects.id, dispute.projectId)).limit(1)
  if (!project) throw Errors.notFound('Project')
  if (project.clientId !== user.id && project.freelancerId !== user.id) throw Errors.forbidden('Participants only')
  if (dispute.status === 'resolved') throw Errors.conflict('dispute_resolved', 'Dispute already resolved')

  const body = await validate(c, z.object({ arbiterAddress: ADDRESS }).strict())
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
  return ok(c, updated)
})

/** Admin assigns an arbiter — only after the 48h agreement window lapses. */
adminDisputeRoutes.post('/disputes/:id/assign-arbiter', writeLimiter(), requireAdmin, async (c) => {
  const db = await getDb()
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, c.req.param('id'))).limit(1)
  if (!dispute) throw Errors.notFound('Dispute')
  if (dispute.status === 'resolved') throw Errors.conflict('dispute_resolved', 'Dispute already resolved')
  if (dispute.status === 'agreed') throw Errors.conflict('dispute_agreed', 'Parties already agreed on an arbiter')
  if (Date.now() < dispute.agreementDeadline.getTime()) {
    throw Errors.precondition('window_open', `Agreement window is still open until ${dispute.agreementDeadline.toISOString()}`)
  }

  const body = await validate(c, z.object({ arbiterAddress: ADDRESS }).strict())
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
  return ok(c, updated)
})

