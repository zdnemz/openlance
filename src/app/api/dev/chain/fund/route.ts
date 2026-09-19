/** POST /api/dev/chain/fund */
import { route, created } from '@/server/lib/route'
import { devFund } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devFund(request)))
