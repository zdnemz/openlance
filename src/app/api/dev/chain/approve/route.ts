/** POST /api/dev/chain/approve */
import { route, created } from '@/server/lib/route'
import { devApprove } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devApprove(request)))
