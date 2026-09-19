/** POST /api/admin/disputes/:id/assign-arbiter */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAdmin } from '@/server/auth/middleware'
import { assignArbiter } from '@/server/modules/disputes'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAdmin(request)
  await writeRateLimit(request, user.id)
  return assignArbiter(request, params.id)
})
