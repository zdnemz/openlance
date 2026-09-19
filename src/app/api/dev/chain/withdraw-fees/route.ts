/** POST /api/dev/chain/withdraw-fees */
import { route, created } from '@/server/lib/route'
import { devWithdrawFees } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devWithdrawFees(request)))
