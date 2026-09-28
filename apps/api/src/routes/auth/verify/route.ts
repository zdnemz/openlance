/** POST /api/auth/verify — SIWE verify OR one-signature voucher login → session token. */
import { route } from '../../../lib/route.ts'
import { authRateLimit } from '../../../lib/rate-limit.ts'
import { ok, withGateCookies } from '../../../lib/http.ts'
import { verifyLogin, verifyVoucherLogin } from '../../../auth/service.ts'

export const POST = route(async (request) => {
  await authRateLimit(request)
  const raw: unknown = await request.json().catch(() => null)
  // A SIWE body carries `message`; a voucher-login body carries sessionId +
  // signature. One endpoint, no extra round-trip to pick the flow.
  const isSiwe = !!raw && typeof (raw as { message?: unknown }).message === 'string'
  const data = isSiwe ? await verifyLogin(raw) : await verifyVoucherLogin(raw)
  return withGateCookies(ok(data), { verified: data.user.kycStatus === 'verified', role: data.user.role })
})
