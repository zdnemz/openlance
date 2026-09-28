/**
 * POST /api/internal/inbound — signature-verified inbound event receiver.
 *
 * Disabled (404) unless INBOUND_WEBHOOK_SECRET is set. Auth is the HMAC
 * signature over the raw body, not a session — so no `requireAuth` here.
 */
import { route } from '../../../lib/route.ts'
import { writeRateLimit } from '../../../lib/rate-limit.ts'
import { receiveInbound } from '../../../modules/inbound.ts'

export const POST = route(async (request) => {
  await writeRateLimit(request)
  return receiveInbound(request)
})
