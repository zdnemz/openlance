/** GET /api/ledger/summary */
import { route } from '@/server/lib/route'
import { ledgerSummary } from '@/server/modules/ledger'

export const dynamic = 'force-dynamic'

export const GET = route(async () => ledgerSummary())
