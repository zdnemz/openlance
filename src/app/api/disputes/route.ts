/** GET /api/disputes */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { listDisputes } from '@/server/modules/disputes'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listDisputes(request)
})
