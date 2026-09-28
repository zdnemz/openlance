/** POST /api/dev/chain/cancel */
import { route, created } from '../../../../lib/route.ts'
import { devCancel } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devCancel(request)))
