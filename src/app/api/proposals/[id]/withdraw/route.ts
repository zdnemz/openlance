/** PATCH /api/proposals/:id/withdraw */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { withdrawProposal } from '@/server/modules/proposals'

export const dynamic = 'force-dynamic'

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return withdrawProposal(request, params.id)
})
