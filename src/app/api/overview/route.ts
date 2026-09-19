/** GET /api/overview */
import { route } from '@/server/lib/route'
import { overview } from '@/server/modules/overview'

export const dynamic = 'force-dynamic'

export const GET = route(async () => overview())
