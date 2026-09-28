/** POST /api/webhooks/:id/deliveries/:deliveryId/redeliver — re-queue a delivery. */
import { route } from '../../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../../auth/middleware.ts'
import { redeliver } from '../../../../../../modules/webhooks.ts'

export const POST = route<{ id: string; deliveryId: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return redeliver(request, params.id, params.deliveryId)
})
