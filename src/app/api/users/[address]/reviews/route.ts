/** GET /api/users/:address/reviews */
import { route } from '@/server/lib/route'
import { getUserReviews } from '@/server/modules/users'

export const dynamic = 'force-dynamic'

export const GET = route<{ address: string }>(async (_request, { params }) => getUserReviews(params.address))
