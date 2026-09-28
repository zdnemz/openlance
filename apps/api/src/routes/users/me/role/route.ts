/** POST /api/users/me/role — set the initial role during onboarding (one-way). */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { ok, withOnboardedCookie } from '../../../../lib/http.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { switchRole } from '../../../../modules/users.ts'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  const updated = await switchRole(request)
  // Initial pick only: KYC is always 'none' here, so this never verifies —
  // the onboarded cookie stays '0' until the KYC step completes.
  return withOnboardedCookie(ok(updated), updated.kycStatus === 'verified')
})
