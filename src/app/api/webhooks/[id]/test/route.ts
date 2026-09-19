/** POST /api/webhooks/:id/test — send a signed synthetic ping to the endpoint. */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { testWebhook } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return testWebhook(request, params.id)
})
