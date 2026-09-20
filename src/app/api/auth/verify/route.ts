/** POST /api/auth/verify — SIWE verify → mint a session token. */
import { route } from '@/server/lib/route'
import { authRateLimit } from '@/server/lib/rate-limit'
import { ok, withGateCookies } from '@/server/lib/http'
import { verifyLogin } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  await authRateLimit(request)
  const data = await verifyLogin(request)
  return withGateCookies(ok(data), { verified: data.user.kycStatus === 'verified', role: data.user.role })
})
