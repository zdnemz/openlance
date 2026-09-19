/** GET /api/users/:address */
import { route } from '@/server/lib/route'
import { getUserByAddress } from '@/server/modules/users'

export const dynamic = 'force-dynamic'

export const GET = route<{ address: string }>(async (_request, { params }) => getUserByAddress(params.address))
