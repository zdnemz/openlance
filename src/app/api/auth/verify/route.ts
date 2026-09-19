/** POST /api/auth/verify — SIWE verify → mint a session token. */
import { route } from '@/server/lib/route'
import { authRateLimit } from '@/server/lib/rate-limit'
import { verifyLogin } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  await authRateLimit(request)
  return verifyLogin(request)
})
