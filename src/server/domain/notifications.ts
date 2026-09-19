/** Canonical notification event types + webhook envelope (PRD F9). */
export const NOTIFICATION_TYPES = [
  'proposal.received',
  'proposal.accepted',
  'proposal.rejected',
  'project.created',
  'milestone.funded',
  'submission.received',
  'milestone.changes_requested',
  'dispute.opened',
  'dispute.arbiters_selected', // random arbiter pool chosen on-chain
  'dispute.vote_committed',
  'dispute.vote_revealed',
  'dispute.finalized', // majority tallied (payout may still be pending appeal window)
  'dispute.no_quorum', // fewer than 2 reveals → refunded to opener
  'dispute.tally_due', // reveal window closed, tally pending
  'dispute.appealed',
  'dispute.arbiter_agreed',
  'dispute.arbiter_assigned',
  'dispute.resolved',
  'milestone.released',
  'milestone.refunded',
  'milestone.split',
  'project.completed',
  'review.received',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

export interface WebhookEnvelope {
  id: string
  type: NotificationType | string
  ts: string
  actor: string | null // wallet address or null for system/chain events
  projectId: string | null
  milestoneId: string | null
  payload: Record<string, unknown>
}

export function buildEnvelope(input: {
  id: string
  type: NotificationType | string
  actorAddress?: string | null
  projectId?: string | null
  milestoneId?: string | null
  payload?: Record<string, unknown>
}): WebhookEnvelope {
  return {
    id: input.id,
    type: input.type,
    ts: new Date().toISOString(),
    actor: input.actorAddress ?? null,
    projectId: input.projectId ?? null,
    milestoneId: input.milestoneId ?? null,
    payload: input.payload ?? {},
  }
}
