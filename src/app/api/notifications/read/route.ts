/** POST /api/notifications/read — mark inbox items (or all) as read. */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { markNotificationsRead } from '@/server/modules/notifications'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return markNotificationsRead(request)
})
