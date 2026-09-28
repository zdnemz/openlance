/** GET /api/projects/:id/messages · POST /api/projects/:id/messages */
import { route } from '../../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { createMessage, listMessages } from '../../../../modules/chat.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listMessages(request, params.id)
})

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return createMessage(request, params.id)
})
