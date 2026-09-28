/** POST /api/attachments/:id/confirm */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { confirmAttachment } from '../../../../modules/files.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return confirmAttachment(request, params.id)
})
