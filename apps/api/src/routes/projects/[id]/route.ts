/** GET /api/projects/:id */
import { route } from '../../../lib/route.ts'
import { readRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { getProject } from '../../../modules/projects.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return getProject(request, params.id)
})
