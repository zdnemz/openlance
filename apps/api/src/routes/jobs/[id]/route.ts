/** GET /api/jobs/:id · PATCH /api/jobs/:id · DELETE /api/jobs/:id */
import { route } from '../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../lib/rate-limit.ts'
import { optionalAuth, requireAuth } from '../../../auth/middleware.ts'
import { deleteJob, getJob, updateJob } from '../../../modules/jobs.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await optionalAuth(request)
  await readRateLimit(request, user?.id)
  return getJob(params.id, request)
})

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return updateJob(request, params.id)
})

export const DELETE = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return deleteJob(request, params.id)
})
