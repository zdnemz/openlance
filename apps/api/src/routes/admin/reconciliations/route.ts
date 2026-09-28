/** GET /api/admin/reconciliations */
import { route } from '../../../lib/route.ts'
import { readRateLimit } from '../../../lib/rate-limit.ts'
import { requireAdmin } from '../../../auth/middleware.ts'
import { adminReconciliations } from '../../../modules/admin.ts'

export const GET = route(async (request) => {
  const user = await requireAdmin(request)
  await readRateLimit(request, user.id)
  return adminReconciliations(request)
})
