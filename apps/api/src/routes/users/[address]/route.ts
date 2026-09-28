/** GET /api/users/:address */
import { route } from '../../../lib/route.ts'
import { getUserByAddress } from '../../../modules/users.ts'

export const GET = route<{ address: string }>(async (_request, { params }) => getUserByAddress(params.address))
