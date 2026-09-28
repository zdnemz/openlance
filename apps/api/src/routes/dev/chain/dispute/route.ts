/** POST /api/dev/chain/dispute */
import { route, created } from '../../../../lib/route.ts'
import { devDispute } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devDispute(request)))
