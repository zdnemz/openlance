/** POST /api/users/me/kyc — submit simulated KYC; POST .../approve — demo self-approve. */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { ok, withGateCookies } from '@/server/lib/http'
import { requireAuth } from '@/server/auth/middleware'
import { approveOwnKyc, submitKyc } from '@/server/modules/users'

export const dynamic = 'force-dynamic'

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
