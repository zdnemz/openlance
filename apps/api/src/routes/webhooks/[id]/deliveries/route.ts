/** GET /api/webhooks/:id/deliveries */
import { route } from '../../../../lib/route.ts'
import { readRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { listDeliveries } from '../../../../modules/webhooks.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listDeliveries(request, params.id)
})
