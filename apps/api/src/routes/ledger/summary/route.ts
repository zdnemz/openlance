/** GET /api/ledger/summary */
import { route } from '../../../lib/route.ts'
import { ledgerSummary } from '../../../modules/ledger.ts'

export const GET = route(async () => ledgerSummary())
