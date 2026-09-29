/** POST /api/proposals/:id/attachments — init upload for a bid's supporting file */
import { route, created } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { initProposalAttachment } from '../../../../modules/files.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await initProposalAttachment(request, params.id))
})
