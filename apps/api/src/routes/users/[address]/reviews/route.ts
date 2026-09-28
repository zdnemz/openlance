/** GET /api/users/:address/reviews */
import { route } from '../../../../lib/route.ts'
import { getUserReviews } from '../../../../modules/users.ts'

export const GET = route<{ address: string }>(async (_request, { params }) => getUserReviews(params.address))
