/** GET /api/arbiters/:address */
import { route } from '@/server/lib/route'
import { getArbiter } from '@/server/modules/arbiters'

export const dynamic = 'force-dynamic'

export const GET = route<{ address: string }>(async (_request, { params }) => getArbiter(params.address))
