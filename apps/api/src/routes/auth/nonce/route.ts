/** GET /api/auth/nonce — issue a single-use SIWE nonce. */
import { route } from '../../../lib/route.ts'
import { authRateLimit } from '../../../lib/rate-limit.ts'
import { getNonce } from '../../../auth/service.ts'

export const GET = route(async (request) => {
  await authRateLimit(request)
  return getNonce()
})
