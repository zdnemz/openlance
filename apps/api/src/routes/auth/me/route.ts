/** GET /api/auth/me — the authenticated profile. */
import { route } from '../../../lib/route.ts'
import { me } from '../../../auth/service.ts'

export const GET = route(async (request) => me(request))
