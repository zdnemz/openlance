/** POST /api/admin/indexer/reset */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAdmin } from '@/server/auth/middleware'
import { adminResetIndexer } from '@/server/modules/admin'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  const user = await requireAdmin(request)
  await writeRateLimit(request, user.id)
  return adminResetIndexer(request)
})
