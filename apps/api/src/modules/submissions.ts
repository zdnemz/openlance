/**
 * /projects/:id/milestones/:mid/submissions (PRD F8).
 *
 * A submission is deliberately TWO acts:
 *  (a) off-chain — the record: notes + attachments (this module)
 *  (b) on-chain  — markSubmitted(milestoneId) by the freelancer's wallet.
 * The indexer links them; request-changes is an off-chain soft state.
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { requireAuth, requireKyc } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { emitNotification } from './notify.ts'
import { attachments, projectMilestones, submissionAttachments, submissions } from '../db/schema.ts'
import { loadMilestone, requireParticipant, requireParticipantOrArbiter, ensureMilestoneOnchain } from './helpers.ts'
import { MAX_OWNER_ATTACHMENTS } from '../storage/index.ts'

/** Re-exported for the check script; the invariant lives with the storage policy. */
export const MAX_SUBMISSION_ATTACHMENTS = MAX_OWNER_ATTACHMENTS

export async function createSubmission(request: Request, projectId: string, milestoneId: string) {
  const user = await requireKyc(request)
  await requireParticipant(projectId, user)
  const { milestone, project } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (project.freelancerId !== user.id) throw Errors.forbidden('Only the freelancer may submit')
  // Resolve-on-write: the mirror may have missed the funding (stuck at
  // pending_funding with no onchainId) while the chain is already funded —
  // repair from chain truth before gating, so landed work is never bricked.
  const { milestone: current } = await ensureMilestoneOnchain(milestone)
  // A revision re-records the delivery against a milestone the chain already
  // holds as `submitted`. Escrow.submit() reverts on anything but Funded, so a
  // revision is deliberately OFF-CHAIN ONLY — the on-chain state is already the
  // one the client is deciding on. Gating on `funded` alone left the freelancer
  // stranded after a request-changes: the API refused the re-submission and the
  // room showed no control, so the milestone could only be approved or disputed.
  const isRevision = current.softStatus === 'changes_requested' && current.chainStatus === 'submitted'
  if (!isRevision && current.chainStatus !== 'funded') {
    throw Errors.conflict('milestone_not_fundable', `Milestone is ${current.chainStatus}; expected funded`)
  }

  const body = await validate(request, z.object({
    notes: z.string().min(1).max(20000),
    attachmentIds: z.array(z.string().uuid()).max(MAX_SUBMISSION_ATTACHMENTS).default([]),
  }).strict())

  const db = getDb()
  const created = await db.transaction(async (tx) => {
    if (body.attachmentIds.length) {
      const atts = await tx.select().from(attachments).where(inArray(attachments.id, body.attachmentIds))
      if (atts.length !== body.attachmentIds.length) throw Errors.badRequest('attachment_unknown', 'Unknown attachment id')
      for (const a of atts) {
        if (a.projectId !== project.id) throw Errors.badRequest('attachment_unknown', 'Attachment from another project')
        if (a.status !== 'confirmed') throw Errors.badRequest('attachment_not_uploaded', 'Attachment has not been uploaded yet')
      }
    }
    const [s] = await tx.insert(submissions).values({
      milestoneId: milestone.id, authorId: user.id, notes: body.notes,
    }).returning()
    if (body.attachmentIds.length) {
      await tx.insert(submissionAttachments).values(body.attachmentIds.map((aid) => ({ submissionId: s!.id, attachmentId: aid })))
    }
    // soft state: latest submission pending client action
    await tx.update(projectMilestones).set({ softStatus: 'submitted', updatedAt: new Date() })
      .where(eq(projectMilestones.id, milestone.id))
    return s!
  })

  await emitNotification({
    type: 'submission.received',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { milestoneTitle: milestone.title, position: milestone.position, submissionId: created.id, revision: isRevision },
  })
  // A first submission still owes the chain its `submit()`; a revision does not,
  // and re-sending that tx would revert against the Submitted milestone.
  return isRevision
    ? { ...created, onchainActionRequired: null, onchainId: current.onchainId }
    : { ...created, onchainActionRequired: 'markSubmitted', onchainId: current.onchainId }
}

/** Client-side soft "request changes" — chain stays `Submitted`. */
export async function requestChanges(request: Request, projectId: string, milestoneId: string) {
  const user = await requireKyc(request)
  await requireParticipant(projectId, user)
  const { milestone, project } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (project.clientId !== user.id) throw Errors.forbidden('Only the client may request changes')
  if (milestone.chainStatus !== 'submitted') {
    throw Errors.conflict('milestone_not_submitted', `Milestone is ${milestone.chainStatus}; expected submitted`)
  }
  const body = await validate(request, z.object({ note: z.string().max(2000).optional() }).strict())

  const db = getDb()
  const [updated] = await db.update(projectMilestones)
    .set({ softStatus: 'changes_requested', softStatusNote: body.note ?? null, updatedAt: new Date() })
    .where(eq(projectMilestones.id, milestone.id)).returning()

  await emitNotification({
    type: 'milestone.changes_requested',
    actorAddress: user.walletAddress,
    projectId: project.id,
    milestoneId: milestone.id,
    payload: { note: body.note ?? null },
  })
  return updated
}

export async function listSubmissions(request: Request, projectId: string, milestoneId: string) {
  const user = await requireAuth(request)
  // The delivery is the evidence a seated arbiter rules on.
  await requireParticipantOrArbiter(projectId, user)
  const { milestone, project } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  const db = getDb()
  const rows = await db.select().from(submissions).where(eq(submissions.milestoneId, milestone.id))
    .orderBy(desc(submissions.createdAt))
  const links = rows.length
    ? await db.select().from(submissionAttachments)
        .where(inArray(submissionAttachments.submissionId, rows.map((r) => r.id)))
    : []
  const attIds = [...new Set(links.map((l) => l.attachmentId))]
  const atts = attIds.length ? await db.select().from(attachments).where(inArray(attachments.id, attIds)) : []
  return rows.map((s) => ({
    ...s,
    // Filter the dangling-link case: the FK cascades, but the read model should
    // never hand the UI an `undefined` hole inside `attachments`.
    attachments: links
      .filter((l) => l.submissionId === s.id)
      .map((l) => atts.find((a) => a.id === l.attachmentId))
      .filter((a): a is NonNullable<typeof a> => !!a),
  }))
}
