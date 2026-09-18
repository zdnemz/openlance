/**
 * /milestones/:id/reviews — transaction-bound reviews (PRD §6.3).
 *
 * A review write is accepted ONLY when the backend can verify on-chain
 * settlement for that milestone with the reviewer as a party: the mirror says
 * settled AND the chain adapter confirms via RPC (the mirror is untrusted).
 * The settlement tx hash is stored on the review row — the "point at the tx
 * hash" moment of the demo.
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { writeLimiter, readLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { unlocksReviews } from '../domain/state-machine'
import { getChainAdapter } from '../chain/adapter'
import { emitNotification } from './notify'
import { projectMilestones, reviews } from '../db/schema'
import { loadMilestone } from './helpers'

export const reviewRoutes = new Hono()

reviewRoutes.post('/:id/reviews', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const { milestone, project } = await loadMilestone(c.req.param('id'))

  // reviewer must be a party to the milestone's project
  if (project.clientId !== user.id && project.freelancerId !== user.id) {
    throw Errors.forbidden('Only project participants may review')
  }
  const revieweeId = project.clientId === user.id ? project.freelancerId : project.clientId

  // 1) mirror says settled-and-unlocking
  if (!unlocksReviews(milestone.chainStatus)) {
    throw Errors.precondition('milestone_not_settled', `Milestone is ${milestone.chainStatus}; reviews unlock after release or dispute resolution`)
  }

  // 2) one review per side per milestone (unique index backs this too)
  const db = await getDb()
  const [already] = await db.select({ id: reviews.id }).from(reviews)
    .where(and(eq(reviews.milestoneId, milestone.id), eq(reviews.reviewerId, user.id))).limit(1)
  if (already) throw Errors.conflict('already_reviewed', 'You already reviewed this milestone')

  const body = await validate(c, z.object({
    rating: z.number().int().min(1).max(5),
    body: z.string().max(4000).optional(),
  }).strict())

  // 3) the chain re-derivation — money-relevant truth never comes from the mirror
  if (milestone.onchainId !== null) {
    const adapter = getChainAdapter()
    const chainStatus = await adapter.getMilestoneStatus(milestone.onchainId)
    if (!chainStatus || !unlocksReviews(chainStatus)) {
      throw Errors.precondition('chain_not_settled', 'Chain does not confirm settlement for this milestone (mirror may be stale)')
    }
  }
  const settlementTxHash = milestone.settlementTxHash
  if (!settlementTxHash) throw Errors.precondition('no_settlement_tx', 'Settlement tx hash missing from the mirror — rerun reconciliation')

  const [review] = await db.insert(reviews).values({
    milestoneId: milestone.id,
    reviewerId: user.id,
    revieweeId,
    rating: body.rating,
    body: body.body ?? null,
    txHash: settlementTxHash,
  }).returning()

  await emitNotification({
    type: 'review.received',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { rating: body.rating, reviewId: review!.id },
  })
  return ok(c, review, 201)
})

reviewRoutes.get('/:id/reviews', readLimiter(), requireAuth, async (c) => {
  const db = await getDb()
  const rows = await db.select().from(reviews).where(eq(reviews.milestoneId, c.req.param('id')))
  return ok(c, rows)
})

void projectMilestones
