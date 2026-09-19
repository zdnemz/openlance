/** GET /api/auth/me — the authenticated profile. */
import { route } from '@/server/lib/route'
import { me } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => me(request))
