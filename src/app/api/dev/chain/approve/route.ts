/** POST /api/dev/chain/approve */
import { route } from '@/server/lib/route'
import { devApprove } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => devApprove(request))
