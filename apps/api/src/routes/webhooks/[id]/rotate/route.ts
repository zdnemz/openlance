/** POST /api/webhooks/:id/rotate — rotate the HMAC signing secret. */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { rotateSecret } from '../../../../modules/webhooks.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return rotateSecret(request, params.id)
})
