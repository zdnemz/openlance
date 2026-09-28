/** GET /api/dev/chain/state */
import { route } from '../../../../lib/route.ts'
import { devState } from '../../../../modules/devchain.ts'

export const GET = route(async () => devState())
