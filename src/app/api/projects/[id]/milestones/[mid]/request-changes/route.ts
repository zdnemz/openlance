/** POST /api/projects/:id/milestones/:mid/request-changes */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { requestChanges } from '@/server/modules/submissions'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string; mid: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return requestChanges(request, params.id, params.mid)
})
