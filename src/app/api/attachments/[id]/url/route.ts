/** GET /api/attachments/:id/url — participant-checked signed download URL */
import { route } from '@/server/lib/route'
import { readRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { attachmentUrl } from '@/server/modules/files'

export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return attachmentUrl(request, params.id)
})
