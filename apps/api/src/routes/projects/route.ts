/** GET /api/projects */
import { route } from '../../lib/route.ts'
import { readRateLimit } from '../../lib/rate-limit.ts'
import { requireAuth } from '../../auth/middleware.ts'
import { listProjects } from '../../modules/projects.ts'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProjects(request)
})
