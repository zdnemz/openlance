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
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { emitNotification } from './notify'
import { attachments, projectMilestones, submissionAttachments, submissions } from '../db/schema'
import { loadMilestone, requireParticipant } from './helpers'

export async function createSubmission(request: Request, projectId: string, milestoneId: string) {
  const user = await requireKyc(request)
  await requireParticipant(projectId, user)
  const { milestone, project } = await loadMilestone(milestoneId)
  if (milestone.projectId !== project.id) throw Errors.notFound('Milestone in this project')
  if (project.freelancerId !== user.id) throw Errors.forbidden('Only the freelancer may submit')
  if (milestone.chainStatus !== 'funded') {
    throw Errors.conflict('milestone_not_fundable', `Milestone is ${milestone.chainStatus}; expected funded`)
  }

  const body = await validate(request, z.object({
    notes: z.string().min(1).max(20000),
    attachmentIds: z.array(z.string().uuid()).max(10).default([]),
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
    payload: { milestoneTitle: milestone.title, position: milestone.position, submissionId: created.id },
  })
  return { ...created, onchainActionRequired: 'markSubmitted', onchainId: milestone.onchainId }
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
  await requireParticipant(projectId, user)
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
    attachments: links.filter((l) => l.submissionId === s.id).map((l) => atts.find((a) => a.id === l.attachmentId)),
  }))
}
