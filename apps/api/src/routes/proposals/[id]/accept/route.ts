/** POST /api/proposals/:id/accept — the award bridge event. */
import { route, created } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { acceptProposal } from '../../../../modules/proposals.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await acceptProposal(request, params.id))
})
