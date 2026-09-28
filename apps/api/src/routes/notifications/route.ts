/** GET /api/notifications — in-app inbox feed + unread count. */
import { route } from '../../lib/route.ts'
import { readRateLimit } from '../../lib/rate-limit.ts'
import { requireAuth } from '../../auth/middleware.ts'
import { getInbox } from '../../modules/notifications.ts'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return getInbox(request)
})
