/**
 * /api/auth/sponsorship — login-time gasless-session handshake.
 *
 *   GET  → the EIP-712 challenge (domain, types, message{owner,issuedAt,expiry,sessionId})
 *   POST → persist the client's signed SponsorshipSession voucher
 *
 * The session expires with the login session (JWT TTL), so voucher lifetime is
 * bound to the authenticated session, per the feature spec.
 */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { requireAuth } from '../../../auth/middleware.ts'
import { getSponsorshipChallenge, postSponsorshipSession } from '../../../auth/service.ts'

export const GET = route(async (request) => getSponsorshipChallenge(request))

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return postSponsorshipSession(request)
})
