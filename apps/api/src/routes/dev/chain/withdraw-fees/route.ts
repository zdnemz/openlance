/** POST /api/dev/chain/withdraw-fees */
import { route, created } from '../../../../lib/route.ts'
import { devWithdrawFees } from '../../../../modules/devchain.ts'

export const POST = route(async () => created(await devWithdrawFees()))
