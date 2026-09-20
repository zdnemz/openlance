/**
 * /api/auth/sponsorship — login-time gasless-session handshake.
 *
 *   GET  → the EIP-712 challenge (domain, types, message{owner,issuedAt,expiry,sessionId})
 *   POST → persist the client's signed SponsorshipSession voucher
 *
 * The session expires with the login session (JWT TTL), so voucher lifetime is
 * bound to the authenticated session, per the feature spec.
 */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { getSponsorshipChallenge, postSponsorshipSession } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => getSponsorshipChallenge(request))

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return postSponsorshipSession(request)
})
