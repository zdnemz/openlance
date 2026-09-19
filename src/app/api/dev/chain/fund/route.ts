/** POST /api/dev/chain/fund */
import { route } from '@/server/lib/route'
import { devFund } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => devFund(request))
