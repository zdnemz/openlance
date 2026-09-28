/** POST /api/notifications/read — mark inbox items (or all) as read. */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { markNotificationsRead } from '../../../modules/notifications.ts'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return markNotificationsRead(request)
})
