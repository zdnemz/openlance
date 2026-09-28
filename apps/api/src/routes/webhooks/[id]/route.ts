/** DELETE /api/webhooks/:id */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { deleteWebhook } from '../../../modules/webhooks.ts'

export const DELETE = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return deleteWebhook(request, params.id)
})
