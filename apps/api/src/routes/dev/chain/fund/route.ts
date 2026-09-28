/** POST /api/dev/chain/fund */
import { route, created } from '../../../../lib/route.ts'
import { devFund } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devFund(request)))
