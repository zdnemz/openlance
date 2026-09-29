/** POST /api/projects/:id/messages/read — move this viewer's read cursor. */
import { route } from '../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../auth/middleware.ts'
import { markMessagesRead } from '../../../../../modules/chat.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return markMessagesRead(request, params.id)
})
