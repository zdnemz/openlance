/** POST /api/dev/chain/resolve */
import { route, created } from '../../../../lib/route.ts'
import { devResolve } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devResolve(request)))
