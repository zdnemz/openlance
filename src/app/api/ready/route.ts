/** GET /api/ready */
import { route } from '@/server/lib/route'
import { ready } from '@/server/modules/overview'

export const dynamic = 'force-dynamic'

export const GET = route(async () => ready())
