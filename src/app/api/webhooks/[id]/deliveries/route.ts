/** GET /api/webhooks/:id/deliveries */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { listDeliveries } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listDeliveries(request, params.id)
})
