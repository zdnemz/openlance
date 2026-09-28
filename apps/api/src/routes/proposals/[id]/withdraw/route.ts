/** PATCH /api/proposals/:id/withdraw */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { withdrawProposal } from '../../../../modules/proposals.ts'

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return withdrawProposal(request, params.id)
})
