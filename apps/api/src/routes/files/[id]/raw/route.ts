/** PUT/GET /api/files/:id/raw — local-driver upload + signed download */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { getAttachmentRaw, putAttachmentRaw } from '../../../../modules/files.ts'

export const PUT = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return putAttachmentRaw(request, params.id)
})

export const GET = route<{ id: string }>(async (_request, { params, url }) => getAttachmentRaw(params.id, url))
