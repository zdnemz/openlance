/** GET /api/dev/chain/state */
import { route } from '@/server/lib/route'
import { devState } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const GET = route(async () => devState())
