/** POST /api/dev/chain/dispute */
import { route, created } from '@/server/lib/route'
import { devDispute } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devDispute(request)))
