/** GET /api/jobs/:id · PATCH /api/jobs/:id */
import { route } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { optionalAuth, requireAuth } from '@/server/auth/middleware'
import { getJob, updateJob } from '@/server/modules/jobs'

export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await optionalAuth(request)
  await readRateLimit(request, user?.id)
  return getJob(params.id)
})

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return updateJob(request, params.id)
})
