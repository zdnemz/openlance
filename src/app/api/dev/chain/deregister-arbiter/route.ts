/** POST /api/dev/chain/deregister-arbiter */
import { route, created } from '@/server/lib/route'
import { devDeregisterArbiter } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devDeregisterArbiter(request)))
