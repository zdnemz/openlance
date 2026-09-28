/** GET /api/projects/:id/milestones */
import { route } from '../../../../lib/route.ts'
import { readRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { listProjectMilestones } from '../../../../modules/projects.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProjectMilestones(request, params.id)
})
