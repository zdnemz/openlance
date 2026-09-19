/** POST /api/dev/chain/cancel */
import { route } from '@/server/lib/route'
import { devCancel } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => devCancel(request))
