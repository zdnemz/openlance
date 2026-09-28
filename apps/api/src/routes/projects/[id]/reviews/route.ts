/** GET /api/projects/:id/reviews */
import { route } from '../../../../lib/route.ts'
import { readRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { listProjectReviews } from '../../../../modules/projects.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProjectReviews(request, params.id)
})
