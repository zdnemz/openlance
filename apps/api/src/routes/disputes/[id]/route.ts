/** GET /api/disputes/:id */
import { route } from '../../../lib/route.ts'
import { readRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { getDispute } from '../../../modules/disputes.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return getDispute(request, params.id)
})
