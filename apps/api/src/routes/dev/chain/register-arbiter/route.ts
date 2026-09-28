/** POST /api/dev/chain/register-arbiter */
import { route, created } from '../../../../lib/route.ts'
import { devRegisterArbiter } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devRegisterArbiter(request)))
