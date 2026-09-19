/**
 * /milestones/:id/reviews — transaction-bound reviews (PRD §6.3).
 *
 * A review write is accepted ONLY when the backend can verify on-chain
 * settlement for that milestone with the reviewer as a party: the mirror says
 * settled AND the chain adapter confirms via RPC (the mirror is untrusted).
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { unlocksReviews } from '../domain/state-machine'
import { getChainAdapter } from '../chain/adapter'
import { emitNotification } from './notify'
import { reviews, users } from '../db/schema'
import { loadMilestone } from './helpers'

export async function createReview(request: Request, milestoneId: string) {
  const user = await requireAuth(request)
  const { milestone, project } = await loadMilestone(milestoneId)

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
  const db = getDb()
  const [already] = await db.select({ id: reviews.id }).from(reviews)
    .where(and(eq(reviews.milestoneId, milestone.id), eq(reviews.reviewerId, user.id))).limit(1)
  if (already) throw Errors.conflict('already_reviewed', 'You already reviewed this milestone')

  const body = await validate(request, z.object({
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

  const [reviewee] = await db.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, revieweeId)).limit(1)
  await emitNotification({
    type: 'review.received',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { rating: body.rating, reviewId: review!.id, revieweeAddress: reviewee?.walletAddress ?? null },
  })
  return review
}

export async function listReviews(milestoneId: string) {
  const db = getDb()
  return db.select().from(reviews).where(eq(reviews.milestoneId, milestoneId))
}
