/** GET /api/ledger */
import { route } from '../../lib/route.ts'
import { listLedger } from '../../modules/ledger.ts'

export const GET = route(async (request) => listLedger(request))
