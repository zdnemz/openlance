/** POST /api/projects/:id/attachments — init upload */
import { route, created } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { initAttachment } from '../../../../modules/files.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await initAttachment(request, params.id))
})
