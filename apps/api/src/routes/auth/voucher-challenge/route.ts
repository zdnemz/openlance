/** GET /api/auth/voucher-challenge?address=0x… — public one-signature login challenge. */
import { z } from 'zod'
import { route } from '../../../lib/route.ts'
import { authRateLimit } from '../../../lib/rate-limit.ts'
import { ok, validateQuery } from '../../../lib/http.ts'
import { issueVoucherLoginChallenge } from '../../../modules/sponsorship.ts'

export const GET = route(async (request, { url }) => {
  await authRateLimit(request)
  const q = validateQuery(url, z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }))
  return ok(await issueVoucherLoginChallenge(q.address))
})
