/**
 * /jobs/:id/proposals + /proposals/:id/* (PRD F2).
 *
 * A proposal is the freelancer's own answer to the brief: their milestone
 * breakdown, their price (a bid, capped by the client's ceiling), their
 * delivery window, and any files backing it. The job post carries none of that.
 *
 * ACCEPTING a proposal is the bridge event: it creates the project + its
 * milestones from the winning proposal's breakdown, locks the job, auto-rejects
 * every other proposal, and fans out notifications — all inside one
 * transaction, because a half-awarded job must be impossible. The budget was
 * locked at publish; the client then signs the returned funding payload once to
 * draw the bid out of it, leaving the remainder withdrawable.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { LIVE_PROPOSAL_STATUSES } from '../db/schema.ts'
import { validate } from '../lib/http.ts'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { isValidEthAmount, toWei, toEth } from '../lib/money.ts'
import { emitNotification } from './notify.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { loadJob } from './helpers.ts'
import { attachments, jobs, projectMilestones, projects, proposalMilestones, proposals, users } from '../db/schema.ts'

/**
 * A bid: the freelancer's breakdown, their price, their window. There is no
 * client template to reshape — this breakdown IS the plan, and it becomes the
 * project's milestones if the client accepts.
 */
export const proposalSchema = z.object({
  coverNote: z.string().min(20).max(4000),
  deliveryDays: z.number().int().min(1).max(365),
  milestones: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    amount: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  }).strict()).min(1).max(20),
}).strict()

/**
 * The client's ceiling is the only budget rule left: a bid above it can never
 * be funded, so it is rejected at the edge. A bid under it is legitimate — the
 * price is the freelancer's to set, and the client accepts it explicitly.
 */
export function bidExceedsCeiling(bidWei: bigint, ceilingWei: bigint): boolean {
  return bidWei > ceilingWei
}

function attachmentView(a: typeof attachments.$inferSelect) {
  return { id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, status: a.status }
}

async function proposalView(p: typeof proposals.$inferSelect) {
  const db = getDb()
  const [ms, files] = await Promise.all([
    db.select().from(proposalMilestones).where(eq(proposalMilestones.proposalId, p.id)),
    db.select().from(attachments).where(eq(attachments.proposalId, p.id)),
  ])
  return {
    id: p.id, jobId: p.jobId, freelancerId: p.freelancerId, coverNote: p.coverNote,
    deliveryDays: p.deliveryDays, status: p.status,
    bidTotalWei: p.bidTotalWei, bidTotalEth: toEth(p.bidTotalWei),
    milestones: ms.sort((a, b) => a.position - b.position).map((m) => ({
      position: m.position, title: m.title, description: m.description, amountWei: m.amountWei, amountEth: toEth(m.amountWei),
    })),
    attachments: files.map(attachmentView),
    createdAt: p.createdAt,
  }
}

export async function listProposals(request: Request, jobId: string) {
  const user = await requireAuth(request)
  const job = await loadJob(jobId)
  // Poster sees all proposals; anyone else sees only their own.
  const db = getDb()
  const where = job.posterId === user.id
    ? eq(proposals.jobId, job.id)
    : and(eq(proposals.jobId, job.id), eq(proposals.freelancerId, user.id))
  const rows = await db.select().from(proposals).where(where).orderBy(desc(proposals.createdAt))
  return Promise.all(rows.map(proposalView))
}

export async function createProposal(request: Request, jobId: string) {
  const user = await requireRole(request, ['freelancer'])
  await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.status !== 'open') throw Errors.conflict('job_not_open', 'Only open jobs accept proposals')
  if (job.posterId === user.id) throw Errors.conflict('own_job', 'You cannot bid on your own job')

  const body = await validate(request, proposalSchema)
  const bidTotal = body.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n)
  if (bidExceedsCeiling(bidTotal, BigInt(job.budgetMaxWei))) {
    throw Errors.badRequest(`Bid total (${toEth(bidTotal.toString())} ETH) exceeds the job budget max (${toEth(job.budgetMaxWei)} ETH)`)
  }
  const db = getDb()

  // One LIVE proposal per freelancer per job (PRD F2) — enforced by the partial
  // unique index, which only covers submitted/accepted. Withdrawn and rejected
  // are terminal, so a freelancer who pulled their bid may bid again; the guard
  // below mirrors that index exactly, because a mismatch would turn the real
  // constraint violation into a 500 instead of a readable 409.
  const existing = await db.select({ id: proposals.id }).from(proposals)
    .where(and(
      eq(proposals.jobId, job.id),
      eq(proposals.freelancerId, user.id),
      inArray(proposals.status, [...LIVE_PROPOSAL_STATUSES]),
    )).limit(1)
  if (existing.length) throw Errors.conflict('duplicate_proposal', 'You already have a live proposal on this job')

  const [poster] = await db.select({ walletAddress: users.walletAddress }).from(users)
    .where(eq(users.id, job.posterId)).limit(1)
  const posterAddress = poster?.walletAddress ?? null

  const created = await db.transaction(async (tx) => {
    const [p] = await tx.insert(proposals).values({
      jobId: job.id, freelancerId: user.id, coverNote: body.coverNote,
      deliveryDays: body.deliveryDays, bidTotalWei: bidTotal.toString(),
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
  return proposalView(created)
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
  // Withdrawing frees the freelancer's one slot on this job (the partial unique
  // index only covers live statuses), so they may bid again while the job is
  // still open. The row stays as history — it is not deleted.
  await emitNotification({
    type: 'proposal.withdrawn',
    actorAddress: user.walletAddress,
    payload: { jobId: p.jobId, proposalId: p.id },
  })
  return proposalView(updated!)
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

    const bid = ms.reduce((acc, m) => acc + BigInt(m.amountWei), 0n)
    // Re-check against the row we locked, not the pre-transaction read.
    if (bidExceedsCeiling(bid, BigInt(lockedJob!.budgetMaxWei))) {
      throw Errors.conflict('bid_exceeds_ceiling', 'Winning bid exceeds the job budget max')
    }

    const [project] = await tx.insert(projects).values({
      jobId: job.id, proposalId: proposal.id, clientId: user.id, freelancerId: freelancer.id,
    }).returning()

    const createdMilestones = await tx.insert(projectMilestones).values(ms.map((m, i) => ({
      projectId: project!.id, position: i + 1, title: m.title, description: m.description, amountWei: m.amountWei,
    }))).returning({ id: projectMilestones.id, amountWei: projectMilestones.amountWei })

    // The bid's files follow the bid into the project: the winning freelancer
    // still has to deliver the work they put those files forward for.
    const files = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.proposalId, proposal.id))
    if (files.length) {
      await tx.update(attachments).set({ proposalId: null, projectId: project!.id })
        .where(inArray(attachments.id, files.map((f) => f.id)))
    }

    await tx.update(proposals).set({ status: 'accepted', updatedAt: new Date() }).where(eq(proposals.id, proposal.id))
    const losers = await tx.select().from(proposals)
      .where(and(eq(proposals.jobId, job.id), eq(proposals.status, 'submitted')))
    for (const l of losers.filter((l) => l.id !== proposal.id)) {
      await tx.update(proposals).set({ status: 'rejected', updatedAt: new Date() }).where(eq(proposals.id, l.id))
    }
    // Surplus: the vault locked the full ceiling at publish; only the winning
    // bid total stays escrowed. The remainder is NOT refunded on-chain — it
    // stays locked and the poster withdraws it with unlockBudget from the
    // project room.
    const locked = BigInt(lockedJob!.depositAmountWei ?? lockedJob!.budgetMaxWei)
    if (bidExceedsCeiling(bid, locked)) throw Errors.conflict('bid_exceeds_deposit', 'Winning bid exceeds the locked deposit')
    const surplus = locked - bid

    // The bid is what the client is about to commit on-chain; this row records
    // it, and the ceiling minus the bid is what stays withdrawable.
    await tx.update(jobs).set({
      status: 'in_progress', depositAmountWei: bid.toString(), updatedAt: new Date(),
    }).where(eq(jobs.id, job.id))

    return {
      project,
      milestones: ms.length,
      attachments: files.length,
      rejected: losers.filter((l) => l.id !== proposal.id).length,
      bidTotalWei: bid.toString(),
      surplusLockedWei: surplus.toString(),
      fundingItems: createdMilestones.map((m) => ({ ref: uuidToBytes32(m.id), amountWei: m.amountWei })),
    }
  })

  // One action, one inbox row: the award IS "proposal accepted → project
  // created". A second `project.created` event repeated the same fact to both
  // parties and doubled every webhook delivery. `proposal.accepted` already
  // carries projectId, so the row deep-links into the new project.
  await emitNotification({
    type: 'proposal.accepted',
    actorAddress: user.walletAddress,
    projectId: result.project.id,
    payload: { jobId: job.id, jobTitle: job.title, proposalId: proposal.id, freelancer: freelancer.walletAddress, bidTotalWei: result.bidTotalWei, surplusLockedWei: result.surplusLockedWei, milestones: result.milestones, attachments: result.attachments },
  })

  return {
    project: result.project,
    milestonesCreated: result.milestones,
    attachmentsMoved: result.attachments,
    proposalsRejected: result.rejected,
    /** Still locked on-chain, not refunded — withdraw it with unlockBudget. */
    surplusLockedWei: result.surplusLockedWei,
    /**
     * One-signature funding payload: the client signs a single
     * `fundAllFromCredit(jobRef, refs, freelancers, amounts)` tx. The budget is
     * already locked from publish, so this draws the bid out of it; after that
     * starting a milestone needs no further signature.
     */
    funding: {
      jobRef: uuidToBytes32(job.id),
      freelancer: freelancer.walletAddress,
      totalWei: result.bidTotalWei,
      items: result.fundingItems,
    },
  }
}
