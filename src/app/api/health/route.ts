/** GET /api/health */
import { route } from '@/server/lib/route'
import { health } from '@/server/modules/overview'

export const dynamic = 'force-dynamic'

export const GET = route(async () => health())
