/** GET/PATCH /api/notifications/preferences — catalogue + per-type mute toggles. */
import { route } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { getPreferences, updatePreference } from '@/server/modules/notifications'

export const dynamic = 'force-dynamic'

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
