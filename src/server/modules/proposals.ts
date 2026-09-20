/**
 * /jobs/:id/proposals + /proposals/:id/* (PRD F2).
 *
 * ACCEPTING a proposal is the bridge event: it creates the project + its
 * milestones from the winning proposal's own breakdown (which may differ from
 * the job template), locks the job, auto-rejects every other proposal, and
 * fans out notifications. All inside one transaction — a half-awarded job
 * must be impossible.
 */
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isValidEthAmount, toWei, toEth } from '../lib/money'
import { emitNotification } from './notify'
import { loadJobWithTemplate } from './helpers'
import { jobs, projectMilestones, projects, proposalMilestones, proposals, users } from '../db/schema'

const proposalSchema = z.object({
  coverNote: z.string().min(20).max(4000),
  deliveryDays: z.number().int().min(1).max(365),
  /** The freelancer's own milestone breakdown — may differ from the job template. */
  milestones: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    amount: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  }).strict()).min(1).max(20),
}).strict()

function proposalView(p: typeof proposals.$inferSelect, ms: (typeof proposalMilestones.$inferSelect)[]) {
  return {
    id: p.id, jobId: p.jobId, freelancerId: p.freelancerId, coverNote: p.coverNote,
    deliveryDays: p.deliveryDays, status: p.status,
    bidTotalWei: p.bidTotalWei, bidTotalEth: toEth(p.bidTotalWei),
    milestones: ms.sort((a, b) => a.position - b.position).map((m) => ({
      position: m.position, title: m.title, description: m.description, amountWei: m.amountWei, amountEth: toEth(m.amountWei),
    })),
    createdAt: p.createdAt,
  }
}

async function proposalMilestonesFor(proposalId: string) {
  return (await getDb().select().from(proposalMilestones).where(eq(proposalMilestones.proposalId, proposalId)))
}

export async function listProposals(request: Request, jobId: string) {
  const user = await requireAuth(request)
  const { job } = await loadJobWithTemplate(jobId)
  // Poster sees all proposals; anyone else sees only their own.
  const db = getDb()
  const where = job.posterId === user.id
    ? eq(proposals.jobId, job.id)
    : and(eq(proposals.jobId, job.id), eq(proposals.freelancerId, user.id))
  const rows = await db.select().from(proposals).where(where).orderBy(desc(proposals.createdAt))
  return Promise.all(rows.map(async (p) => proposalView(p, await proposalMilestonesFor(p.id))))
}

export async function createProposal(request: Request, jobId: string) {
  const user = await requireRole(request, ['freelancer'])
  await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.status !== 'open') throw Errors.conflict('job_not_open', 'Only open jobs accept proposals')
  if (job.posterId === user.id) throw Errors.conflict('own_job', 'You cannot bid on your own job')

  const body = await validate(request, proposalSchema)
  const db = getDb()

  // One proposal per freelancer per job (PRD F2) — enforced by unique index too.
  const existing = await db.select({ id: proposals.id }).from(proposals)
    .where(and(eq(proposals.jobId, job.id), eq(proposals.freelancerId, user.id))).limit(1)
  if (existing.length) throw Errors.conflict('duplicate_proposal', 'You already proposed on this job')

  const [poster] = await db.select({ walletAddress: users.walletAddress }).from(users)
    .where(eq(users.id, job.posterId)).limit(1)
  const posterAddress = poster?.walletAddress ?? null

  const created = await db.transaction(async (tx) => {
    const bidTotal = body.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n).toString()
    const [p] = await tx.insert(proposals).values({
      jobId: job.id, freelancerId: user.id, coverNote: body.coverNote,
      deliveryDays: body.deliveryDays, bidTotalWei: bidTotal,
    }).returning()
    await tx.insert(proposalMilestones).values(body.milestones.map((m, i) => ({
      proposalId: p!.id, position: i + 1, title: m.title, description: m.description, amountWei: toWei(m.amount),
    })))
    return p!
  })

  await emitNotification({
    type: 'proposal.received',
    actorAddress: user.walletAddress,
    payload: { jobId: job.id, jobTitle: job.title, proposalId: created.id, bidTotalWei: created.bidTotalWei, posterAddress: posterAddress ?? null },
  })
  return proposalView(created, await proposalMilestonesFor(created.id))
}

/** Withdraw — freelancer, while submitted. */
export async function withdrawProposal(request: Request, proposalId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1)
  if (!p) throw Errors.notFound('Proposal')
  if (p.freelancerId !== user.id) throw Errors.forbidden('Not your proposal')
  if (p.status !== 'submitted') throw Errors.conflict('proposal_not_withdrawable', `Proposal is ${p.status}`)
  const [updated] = await db.update(proposals).set({ status: 'withdrawn', updatedAt: new Date() })
    .where(eq(proposals.id, p.id)).returning()
  return proposalView(updated!, await proposalMilestonesFor(updated!.id))
}

/** ACCEPT — the bridge event (see module doc). */
export async function acceptProposal(request: Request, proposalId: string) {
  const user = await requireKyc(request)
  const db = getDb()
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1)
  if (!proposal) throw Errors.notFound('Proposal')
  const [job] = await db.select().from(jobs).where(eq(jobs.id, proposal.jobId)).limit(1)
  if (!job) throw Errors.notFound('Job')
  if (job.posterId !== user.id) throw Errors.forbidden('Only the job poster may award')
  if (job.status !== 'open') throw Errors.conflict('job_not_open', 'Job already awarded or closed')
  if (proposal.status !== 'submitted') throw Errors.conflict('proposal_not_submitted', `Proposal is ${proposal.status}`)

  const [freelancer] = await db.select().from(users).where(eq(users.id, proposal.freelancerId)).limit(1)
  if (!freelancer) throw Errors.notFound('Freelancer')

  const result = await db.transaction(async (tx) => {
    // Lock the job row against double-award races.
    const [lockedJob] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).for('update').limit(1)
    if (lockedJob!.status !== 'open') throw Errors.conflict('job_not_open', 'Job already awarded')

    const ms = (await tx.select().from(proposalMilestones).where(eq(proposalMilestones.proposalId, proposal.id)))
      .sort((a, b) => a.position - b.position)
    if (ms.length === 0) throw Errors.precondition('proposal_has_no_milestones', 'Cannot award a proposal without milestones')

    const [project] = await tx.insert(projects).values({
      jobId: job.id, proposalId: proposal.id, clientId: user.id, freelancerId: freelancer.id,
    }).returning()

    await tx.insert(projectMilestones).values(ms.map((m, i) => ({
      projectId: project!.id, position: i + 1, title: m.title, description: m.description, amountWei: m.amountWei,
    })))

    await tx.update(proposals).set({ status: 'accepted', updatedAt: new Date() }).where(eq(proposals.id, proposal.id))
    const losers = await tx.select().from(proposals)
      .where(and(eq(proposals.jobId, job.id), eq(proposals.status, 'submitted')))
    for (const l of losers.filter((l) => l.id !== proposal.id)) {
      await tx.update(proposals).set({ status: 'rejected', updatedAt: new Date() }).where(eq(proposals.id, l.id))
    }
    await tx.update(jobs).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(jobs.id, job.id))

    return { project, milestones: ms.length, rejected: losers.filter((l) => l.id !== proposal.id).length }
  })

  await emitNotification({
    type: 'proposal.accepted',
    actorAddress: user.walletAddress,
    projectId: result.project.id,
    payload: { jobId: job.id, jobTitle: job.title, proposalId: proposal.id, freelancer: freelancer.walletAddress },
  })
  await emitNotification({
    type: 'project.created',
    actorAddress: user.walletAddress,
    projectId: result.project.id,
    payload: { jobId: job.id, jobTitle: job.title, milestones: result.milestones },
  })

  return {
    project: result.project,
    milestonesCreated: result.milestones,
    proposalsRejected: result.rejected,
  }
}
