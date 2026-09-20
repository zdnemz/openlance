/** POST /api/users/me/role — set the initial role during onboarding (one-way). */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { ok, withOnboardedCookie } from '@/server/lib/http'
import { requireAuth } from '@/server/auth/middleware'
import { switchRole } from '@/server/modules/users'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  const updated = await switchRole(request)
  // Initial pick only: KYC is always 'none' here, so this never verifies —
  // the onboarded cookie stays '0' until the KYC step completes.
  return withOnboardedCookie(ok(updated), updated.kycStatus === 'verified')
})
