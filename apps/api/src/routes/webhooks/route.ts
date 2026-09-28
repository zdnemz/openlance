/** GET/POST /api/webhooks */
import { route, created } from '../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../lib/rate-limit.ts'
import { requireAuth } from '../../auth/middleware.ts'
import { createWebhook, listWebhooks } from '../../modules/webhooks.ts'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listWebhooks(request)
})

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await createWebhook(request))
})
