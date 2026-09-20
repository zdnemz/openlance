/**
 * POST /api/relay/prepare — build the unsigned ForwardRequest for a money action.
 *
 * The server owns the nonce + deadline so the client cannot desync them; the
 * client signs the returned EIP-712 typed data and posts it to /api/relay.
 */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { prepareForwardRequest } from '@/server/modules/sponsorship'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  const body = await request.json().catch(() => ({}))
  return prepareForwardRequest(user.id, user.walletAddress, body)
})
