/** PATCH /api/users/me */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { updateMe } from '@/server/modules/users'

export const dynamic = 'force-dynamic'

export const PATCH = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return updateMe(request)
})
