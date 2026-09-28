/** POST /api/projects/:id/milestones/:mid/request-changes */
import { route } from '../../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../../auth/middleware.ts'
import { requestChanges } from '../../../../../../modules/submissions.ts'

export const POST = route<{ id: string; mid: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return requestChanges(request, params.id, params.mid)
})
