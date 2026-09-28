/** POST/GET /api/projects/:id/milestones/:mid/submissions */
import { route, created } from '../../../../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../../auth/middleware.ts'
import { createSubmission, listSubmissions } from '../../../../../../modules/submissions.ts'

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
