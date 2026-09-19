/** GET /api/projects/:id/messages · POST /api/projects/:id/messages */
import { route } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { createMessage, listMessages } from '@/server/modules/chat'

export const dynamic = 'force-dynamic'

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
