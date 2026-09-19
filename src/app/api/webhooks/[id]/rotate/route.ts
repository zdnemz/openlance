/** POST /api/webhooks/:id/rotate — rotate the HMAC signing secret. */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { rotateSecret } from '@/server/modules/webhooks'

export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return rotateSecret(request, params.id)
})
