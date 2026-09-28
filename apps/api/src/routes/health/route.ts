/** GET /api/health */
import { route } from '../../lib/route.ts'
import { health } from '../../modules/overview.ts'

export const GET = route(async () => health())
