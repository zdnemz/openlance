/** GET /api/projects */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { listProjects } from '@/server/modules/projects'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProjects(request)
})
