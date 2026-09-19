/** GET /api/notifications — in-app inbox feed + unread count. */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { getInbox } from '@/server/modules/notifications'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return getInbox(request)
})
