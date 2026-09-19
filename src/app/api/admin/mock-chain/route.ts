/** GET /api/admin/mock-chain */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAdmin } from '@/server/auth/middleware'
import { adminMockChain } from '@/server/modules/admin'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  const user = await requireAdmin(request)
  await readRateLimit(request, user.id)
  return adminMockChain(request)
})
