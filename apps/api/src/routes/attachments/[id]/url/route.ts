/** GET /api/attachments/:id/url — participant-checked signed download URL */
import { route } from '../../../../lib/route.ts'
import { readRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { attachmentUrl } from '../../../../modules/files.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return attachmentUrl(request, params.id)
})
