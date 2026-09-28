/** POST /api/projects/:id/arbiters/reject */
import { route } from '../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../auth/middleware.ts'
import { rejectArbiters } from '../../../../../modules/project-arbiters.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return rejectArbiters(request, params.id)
})
