/**
 * GET /api/internal/cron — run the scheduled jobs once.
 *
 * The serverless counterpart to `workers/bootstrap.ts`. That module schedules
 * the indexer, SLA scan and reconciliation on in-process `setInterval`s, which
 * a frozen Vercel Function never fires again. An external scheduler (QStash,
 * cron-job.org, GitHub Actions) GETs this route on the cadence each job wants.
 *
 * Auth is `Authorization: Bearer $CRON_SECRET`. Unset → 404, so a deployment
 * that has not opted in exposes no public "run the indexer" button.
 */
import { route } from '../../../lib/route.ts'
import { authorizeCron, runScheduledJobs } from '../../../modules/cron.ts'

export const GET = route(async (request) => {
  authorizeCron(request)
  return { ran: await runScheduledJobs() }
})
