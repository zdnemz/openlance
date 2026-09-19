/** POST /api/auth/logout — revoke the current session (KV denylist). */
import { route } from '@/server/lib/route'
import { logout } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => logout(request))
