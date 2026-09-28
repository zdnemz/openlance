/** POST /api/users/me/kyc — submit simulated KYC; POST .../approve — demo self-approve. */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { ok, withGateCookies } from '../../../../lib/http.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { approveOwnKyc, submitKyc } from '../../../../modules/users.ts'

export const POST = route(async (request, { url }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  if (url.searchParams.get('action') === 'approve') {
    const approved = await approveOwnKyc(request)
    return withGateCookies(ok(approved), { verified: approved.kycStatus === 'verified', role: approved.role })
  }
  const submitted = await submitKyc(request)
  return withGateCookies(ok(submitted), { verified: submitted.user.kycStatus === 'verified', role: submitted.user.role })
})
