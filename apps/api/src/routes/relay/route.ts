/**
 * POST /api/relay — submit a user-signed ForwardRequest via the relayer.
 *
 * The caller must be authenticated; the request must be signed by the caller's
 * own wallet and scoped by an unexpired sponsorship session. The server relayer
 * pays gas (and principal on testnet); the user pays nothing. The forwarder
 * contract re-verifies everything on-chain, so this endpoint is a convenience,
 * not the authority.
 */
import { route } from '../../lib/route.ts'
import { writeRateLimit } from '../../lib/rate-limit.ts'
import { requireAuth } from '../../auth/middleware.ts'
import { relayForwardRequest } from '../../modules/sponsorship.ts'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  const body = await request.json().catch(() => ({}))
  return relayForwardRequest(user.id, user.walletAddress, body)
})
