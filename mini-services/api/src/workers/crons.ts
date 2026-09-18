/**
 * Cron handlers: SLA/assignment-window scan (15 min) + nightly reconciliation.
 * Scheduled by the queue layer (setInterval inline / BullMQ repeatables).
 */
import { and, eq, inArray, lte } from 'drizzle-orm'
import { env } from '../config'
import { getDb } from '../lib/db'
import { logger } from '../lib/logger'
import { runReconciliation } from '../chain/reconcile'
import { emitNotification } from '../modules/notify'
import { disputes, notificationEvents, projectMilestones, projects } from '../db/schema'

const log = logger.child({ component: 'crons' })

/** Disputes whose 48h arbiter-agreement window expired without agreement →
 *  notify (dispute.assignment_due) so the admin can assign an arbiter. */
export async function slaScan(): Promise<{ due: number }> {
  const db = await getDb()
  const now = new Date()
  const stale = await db.select().from(disputes)
    .where(and(inArray(disputes.status, ['open']), lte(disputes.agreementDeadline, now)))

  let due = 0
  for (const d of stale) {
    // de-duplicate: only ping once per dispute
    const existing = await db.select({ id: notificationEvents.id }).from(notificationEvents)
      .where(and(eq(notificationEvents.type, 'dispute.assignment_due'), eq(notificationEvents.milestoneId, d.milestoneId)))
      .limit(1)
    if (existing.length) continue

    const [project] = await db.select().from(projects).where(eq(projects.id, d.projectId)).limit(1)
    const [milestone] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, d.milestoneId)).limit(1)
    await emitNotification({
      type: 'dispute.assignment_due',
      actorAddress: null,
      projectId: d.projectId,
      milestoneId: d.milestoneId,
      payload: {
        disputeId: d.id,
        windowHours: env.ARBITER_AGREEMENT_WINDOW_HOURS,
        jobTitle: project ? undefined : undefined,
        milestoneTitle: milestone?.title ?? null,
        note: 'Agreement window expired — platform admin may assign an arbiter via POST /admin/disputes/:id/assign-arbiter',
      },
    })
    due++
  }
  if (due) log.info('sla scan: assignment-due notifications sent', { due })
  return { due }
}

export async function reconcile(): Promise<{ checked: number; drifts: number }> {
  const r = await runReconciliation()
  return { checked: r.checked, drifts: r.drifts }
}
