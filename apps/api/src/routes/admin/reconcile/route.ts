/** POST /api/admin/reconcile */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAdmin } from '../../../auth/middleware.ts'
import { adminReconcile } from '../../../modules/admin.ts'

export const POST = route(async (request) => {
  const user = await requireAdmin(request)
  await writeRateLimit(request, user.id)
  return adminReconcile(request)
})
