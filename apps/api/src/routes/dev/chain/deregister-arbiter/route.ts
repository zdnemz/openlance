/** POST /api/dev/chain/deregister-arbiter */
import { route, created } from '../../../../lib/route.ts'
import { devDeregisterArbiter } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devDeregisterArbiter(request)))
