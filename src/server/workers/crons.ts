/**
 * Cron handlers: SLA/assignment-window scan (15 min) + nightly reconciliation.
 * Scheduled by the queue layer (setInterval inline / BullMQ repeatables).
 */
import { and, eq, inArray, lte } from 'drizzle-orm'
import { getDb } from '../db'
import { logger } from '../lib/logger'
import { runReconciliation } from '../chain/reconcile'
import { emitNotification } from '../modules/notify'
import { disputes, notificationEvents, projectMilestones, projects } from '../db/schema'

const log = logger.child({ component: 'crons' })

/**
 * Multi-arbiter dispute scan: flag rounds whose reveal deadline has passed with
 * a quorum but no tally yet (anyone can call resolveDispute), so parties are
 * nudged. The old 48h "assign an arbiter" fallback is gone — selection is
 * automatic and random.
 */
export async function slaScan(): Promise<{ due: number }> {
  const db = getDb()
  const now = new Date()
  const pending = await db.select().from(disputes)
    .where(and(inArray(disputes.status, ['open']), lte(disputes.revealDeadline, now)))

  let due = 0
  for (const d of pending) {
    if (d.finalized || d.phase === 'resolved') continue
    // de-duplicate: only ping once per dispute
    const existing = await db.select({ id: notificationEvents.id }).from(notificationEvents)
      .where(and(eq(notificationEvents.type, 'dispute.tally_due'), eq(notificationEvents.milestoneId, d.milestoneId)))
      .limit(1)
    if (existing.length) continue

    const [project] = await db.select().from(projects).where(eq(projects.id, d.projectId)).limit(1)
    const [milestone] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, d.milestoneId)).limit(1)
    await emitNotification({
      type: 'dispute.tally_due',
      actorAddress: null,
      projectId: d.projectId,
      milestoneId: d.milestoneId,
      payload: {
        disputeId: d.id,
        round: d.round,
        revealed: (d.revealedArbiters as string[])?.length ?? 0,
        selected: (d.selectedArbiters as string[])?.length ?? 0,
        jobTitle: project ? undefined : undefined,
        milestoneTitle: milestone?.title ?? null,
        note: 'Reveal window closed — anyone may tally the round (resolveDispute / resolveAppeal).',
      },
    })
    due++
  }
  if (due) log.info('sla scan: tally-due notifications sent', { due })
  return { due }
}

export async function reconcile(): Promise<{ checked: number; drifts: number }> {
  const r = await runReconciliation()
  return { checked: r.checked, drifts: r.drifts }
}
