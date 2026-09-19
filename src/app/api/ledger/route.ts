/** GET /api/ledger */
import { route } from '@/server/lib/route'
import { listLedger } from '@/server/modules/ledger'

export const dynamic = 'force-dynamic'

export const GET = route(async (request) => listLedger(request))
