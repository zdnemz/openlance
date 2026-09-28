/** GET /api/jobs · POST /api/jobs */
import { route, created } from '../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../lib/rate-limit.ts'
import { optionalAuth, requireAuth } from '../../auth/middleware.ts'
import { createJob, listJobs } from '../../modules/jobs.ts'

export const GET = route(async (request) => {
  const user = await optionalAuth(request)
  await readRateLimit(request, user?.id)
  return listJobs(request)
})

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await createJob(request))
})
