/** POST /api/dev/chain/resolve */
import { route, created } from '@/server/lib/route'
import { devResolve } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devResolve(request)))
