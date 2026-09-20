/** POST /api/auth/logout — revoke the session + expire the gate cookie. */
import { route } from '@/server/lib/route'
import { clearOnboardedCookie, ok } from '@/server/lib/http'
import { logout } from '@/server/auth/service'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => clearOnboardedCookie(ok(await logout(request))))
