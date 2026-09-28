/** GET /api/admin/mock-chain */
import { route } from '../../../lib/route.ts'
import { readRateLimit } from '../../../lib/rate-limit.ts'
import { requireAdmin } from '../../../auth/middleware.ts'
import { adminMockChain } from '../../../modules/admin.ts'

export const GET = route(async (request) => {
  const user = await requireAdmin(request)
  await readRateLimit(request, user.id)
  return adminMockChain(request)
})
