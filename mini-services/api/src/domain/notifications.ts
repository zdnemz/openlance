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
  'dispute.arbiter_agreed',
  'dispute.arbiter_assigned',
  'dispute.assignment_due', // 48h window expired, admin action required
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
