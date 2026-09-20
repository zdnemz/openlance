/** POST /api/users/me/role — switch the single active role. */
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
  // Stepping up a role resets KYC → the gate cookie must follow, or the
  // proxy would keep a stale 'verified' pass.
  return withOnboardedCookie(ok(updated), updated.kycStatus === 'verified')
})
