/** GET /api/ready */
import { route } from '../../lib/route.ts'
import { ready } from '../../modules/overview.ts'

export const GET = route(async () => ready())
