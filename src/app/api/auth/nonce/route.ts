/** GET /api/auth/nonce — issue a single-use SIWE nonce. */
import { route } from '@/server/lib/route'
import { authRateLimit } from '@/server/lib/rate-limit'
import { getNonce } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => {
  await authRateLimit(request)
  return getNonce()
})
