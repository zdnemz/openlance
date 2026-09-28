/** GET /api/arbiters */
import { route } from '../../lib/route.ts'
import { listArbiters } from '../../modules/arbiters.ts'

export const GET = route(async () => listArbiters())
