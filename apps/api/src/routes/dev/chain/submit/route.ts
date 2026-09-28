/** POST /api/dev/chain/submit */
import { route, created } from '../../../../lib/route.ts'
import { devSubmit } from '../../../../modules/devchain.ts'

export const POST = route(async (request) => created(await devSubmit(request)))
