/** POST /api/projects/:id/arbiters/propose */
import { route } from '../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../auth/middleware.ts'
import { proposeArbiters } from '../../../../../modules/project-arbiters.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return proposeArbiters(request, params.id)
})
