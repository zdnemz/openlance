/** GET /api/overview */
import { route } from '../../lib/route.ts'
import { overview } from '../../modules/overview.ts'

export const GET = route(async () => overview())
