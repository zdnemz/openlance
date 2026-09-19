/** PUT/GET /api/files/:id/raw — local-driver upload + signed download */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { getAttachmentRaw, putAttachmentRaw } from '@/server/modules/files'

export const dynamic = 'force-dynamic'

export const PUT = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return putAttachmentRaw(request, params.id)
})

export const GET = route<{ id: string }>(async (_request, { params, url }) => getAttachmentRaw(params.id, url))
