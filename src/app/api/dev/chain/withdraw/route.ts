/** POST /api/dev/chain/withdraw */
import { route, created } from '@/server/lib/route'
import { devWithdraw } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devWithdraw(request)))
