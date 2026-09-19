/** POST /api/webhooks/:id/deliveries/:deliveryId/redeliver — re-queue a delivery. */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { redeliver } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string; deliveryId: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return redeliver(request, params.id, params.deliveryId)
})
