/** POST/GET /api/milestones/:id/reviews */
import { route, created } from '../../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { createReview, listReviews } from '../../../../modules/reviews.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await createReview(request, params.id))
})

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listReviews(params.id)
})
