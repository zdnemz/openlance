/** POST /api/dev/chain/approve */
import { route, created } from '../../../../lib/route.ts'
import { devApprove } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devApprove(request)))
