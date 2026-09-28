/** GET /api/admin/overview */
import { route } from '../../../lib/route.ts'
import { readRateLimit } from '../../../lib/rate-limit.ts'
import { requireAdmin } from '../../../auth/middleware.ts'
import { adminOverview } from '../../../modules/admin.ts'

export const GET = route(async (request) => {
  const user = await requireAdmin(request)
  await readRateLimit(request, user.id)
  return adminOverview(request)
})
