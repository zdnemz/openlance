/**
 * /milestones/:id/reviews — transaction-bound reviews (PRD §6.3).
 *
 * A review write is accepted ONLY when the backend can verify on-chain
 * settlement for that milestone with the reviewer as a party: the mirror says
 * settled AND the chain adapter confirms via RPC (the mirror is untrusted).
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { requireKyc } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { unlocksReviews } from '../domain/state-machine.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { enqueueDeliveries, writeOutbox } from './notify.ts'
import { projectMilestones, reviews, users } from '../db/schema.ts'
import { loadMilestone } from './helpers.ts'

/** Terminal states — a milestone that will never move again. */
const COMPLETE_STATES = ['released', 'resolved_release', 'resolved_refund', 'resolved_split', 'cancelled']

/**
 * Reviews close the whole engagement, not a single chunk: they only unlock once
 * EVERY milestone of the project is complete (settled or cancelled). One open
 * chunk means the project is still in flight — reviewing then would judge a race
 * that isn't run.
 */
async function projectIsComplete(projectId: string): Promise<boolean> {
  const db = getDb()
  const ms = await db.select({ chainStatus: projectMilestones.chainStatus })
    .from(projectMilestones).where(eq(projectMilestones.projectId, projectId))
  return ms.length > 0 && ms.every((m) => COMPLETE_STATES.includes(m.chainStatus))
}

export async function createReview(request: Request, milestoneId: string) {
  const user = await requireKyc(request)
  const { milestone, project } = await loadMilestone(milestoneId)

  // reviewer must be a party to the milestone's project
  if (project.clientId !== user.id && project.freelancerId !== user.id) {
    throw Errors.forbidden('Only project participants may review')
  }
  const revieweeId = project.clientId === user.id ? project.freelancerId : project.clientId

  // 1) every milestone of the project must be complete (settled or cancelled)
  if (!(await projectIsComplete(project.id))) {
    throw Errors.precondition('project_not_complete', 'Reviews unlock only once every milestone of the project is complete')
  }

  // 2) this milestone must itself be in an unlocking (settled) state
  if (!unlocksReviews(milestone.chainStatus)) {
    throw Errors.precondition('milestone_not_settled', `Milestone is ${milestone.chainStatus}; reviews unlock after release or dispute resolution`)
  }

  // 3) one review per side per milestone (unique index backs this too)
  const db = getDb()
  const [already] = await db.select({ id: reviews.id }).from(reviews)
    .where(and(eq(reviews.milestoneId, milestone.id), eq(reviews.reviewerId, user.id))).limit(1)
  if (already) throw Errors.conflict('already_reviewed', 'You already reviewed this milestone')

  const body = await validate(request, z.object({
    rating: z.number().int().min(1).max(5),
    body: z.string().max(4000).optional(),
  }).strict())

  // 4) the chain re-derivation — money-relevant truth never comes from the mirror
  if (milestone.onchainId !== null) {
    const adapter = getChainAdapter()
    const chainStatus = await adapter.getMilestoneStatus(milestone.onchainId)
    if (!chainStatus || !unlocksReviews(chainStatus)) {
      throw Errors.precondition('chain_not_settled', 'Chain does not confirm settlement for this milestone (mirror may be stale)')
    }
  }
  const settlementTxHash = milestone.settlementTxHash
  if (!settlementTxHash) throw Errors.precondition('no_settlement_tx', 'Settlement tx hash missing from the mirror — rerun reconciliation')

  // The review and its notification commit together — a review the reviewee is
  // never told about is a silent loss with no retry path (the duplicate-review
  // guard above 409s a second attempt). See disputes.ts for the same fix.
  const [review, deliveryIds] = await db.transaction(async (tx) => {
    const [row] = await tx.insert(reviews).values({
      milestoneId: milestone.id,
      reviewerId: user.id,
      revieweeId,
      rating: body.rating,
      body: body.body ?? null,
      txHash: settlementTxHash,
    }).returning()
    const [reviewee] = await tx.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, revieweeId)).limit(1)
    const ids = await writeOutbox(tx, {
      type: 'review.received',
      actorAddress: user.walletAddress,
      projectId: project.id,
      milestoneId: milestone.id,
      payload: { rating: body.rating, reviewId: row!.id, revieweeAddress: reviewee?.walletAddress ?? null },
    })
    return [row, ids] as const
  })
  await enqueueDeliveries(deliveryIds)
  return review
}

export async function listReviews(milestoneId: string) {
  const db = getDb()
  return db.select().from(reviews).where(eq(reviews.milestoneId, milestoneId))
}
