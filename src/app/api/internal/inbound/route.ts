/**
 * POST /api/internal/inbound — signature-verified inbound event receiver.
 *
 * Disabled (404) unless INBOUND_WEBHOOK_SECRET is set. Auth is the HMAC
 * signature over the raw body, not a session — so no `requireAuth` here.
 */
import { route } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { receiveInbound } from '@/server/modules/inbound'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => {
  await writeRateLimit(request)
  return receiveInbound(request)
})
