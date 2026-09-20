/** POST /api/projects/:id/arbiters/approve */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { approveArbiters } from '@/server/modules/project-arbiters'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return approveArbiters(request, params.id)
})
