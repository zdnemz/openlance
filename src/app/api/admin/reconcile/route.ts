/** POST /api/admin/reconcile */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAdmin } from '@/server/auth/middleware'
import { adminReconcile } from '@/server/modules/admin'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  const user = await requireAdmin(request)
  await writeRateLimit(request, user.id)
  return adminReconcile(request)
})
