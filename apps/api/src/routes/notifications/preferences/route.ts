/** GET/PATCH /api/notifications/preferences — catalogue + per-type mute toggles. */
import { route } from '../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { getPreferences, updatePreference } from '../../../modules/notifications.ts'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return getPreferences(request)
})

export const PATCH = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return updatePreference(request)
})
