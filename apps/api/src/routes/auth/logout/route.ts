/** POST /api/auth/logout — revoke the session + expire the gate cookie. */
import { route } from '../../../lib/route.ts'
import { clearGateCookies, ok } from '../../../lib/http.ts'
import { logout } from '../../../auth/service.ts'

export const POST = route(async (request) => clearGateCookies(ok(await logout(request))))
