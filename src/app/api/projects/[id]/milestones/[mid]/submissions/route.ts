/** POST/GET /api/projects/:id/milestones/:mid/submissions */
import { route, created } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { createSubmission, listSubmissions } from '@/server/modules/submissions'

export const dynamic = 'force-dynamic'

type Params = { id: string; mid: string }

export const POST = route<Params>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await createSubmission(request, params.id, params.mid))
})

export const GET = route<Params>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listSubmissions(request, params.id, params.mid)
})
