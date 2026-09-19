/** POST /api/dev/chain/submit */
import { route, created } from '@/server/lib/route'
import { devSubmit } from '@/server/modules/devchain'

export const dynamic = 'force-dynamic'

export const POST = route(async (request) => created(await devSubmit(request)))
