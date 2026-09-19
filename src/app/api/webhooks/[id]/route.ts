/** DELETE /api/webhooks/:id */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { deleteWebhook } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

export const DELETE = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return deleteWebhook(request, params.id)
})
