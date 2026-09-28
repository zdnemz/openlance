/** GET /api/arbiters/:address */
import { route } from '../../../lib/route.ts'
import { getArbiter } from '../../../modules/arbiters.ts'

export const GET = route<{ address: string }>(async (_request, { params }) => getArbiter(params.address))
