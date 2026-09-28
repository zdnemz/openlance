/** POST /api/dev/chain/withdraw */
import { route, created } from '../../../../lib/route.ts'
import { devWithdraw } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devWithdraw(request)))
