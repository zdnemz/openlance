/** GET /api/arbiters */
import { route } from '@/server/lib/route'
import { listArbiters } from '@/server/modules/arbiters'

export const dynamic = 'force-dynamic'

export const GET = route(async () => listArbiters())
