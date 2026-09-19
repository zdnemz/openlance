/** POST /api/projects/:id/milestones/:mid/disputes */
import { route, created } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { openDispute } from '@/server/modules/disputes'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string; mid: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await openDispute(request, params.id, params.mid))
})
