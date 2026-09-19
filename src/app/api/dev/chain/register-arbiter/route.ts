/** POST /api/dev/chain/register-arbiter */
import { route } from '@/server/lib/route'
import { devRegisterArbiter } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => devRegisterArbiter(request))
