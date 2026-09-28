/** POST /api/webhooks/:id/test — send a signed synthetic ping to the endpoint. */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { testWebhook } from '../../../../modules/webhooks.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return testWebhook(request, params.id)
})
