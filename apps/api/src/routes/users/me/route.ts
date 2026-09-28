/** PATCH /api/users/me */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { updateMe } from '../../../modules/users.ts'

export const PATCH = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return updateMe(request)
})
