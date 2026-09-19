/** GET /api/jobs · POST /api/jobs */
import { route } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { optionalAuth, requireAuth } from '@/server/auth/middleware'
import { createJob, listJobs } from '@/server/modules/jobs'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  const user = await optionalAuth(request)
  await readRateLimit(request, user?.id)
  return listJobs(request)
})

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return createJob(request)
})
