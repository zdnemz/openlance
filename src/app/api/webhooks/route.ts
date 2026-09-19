/** GET/POST /api/webhooks */
import { route, created } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { createWebhook, listWebhooks } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

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
