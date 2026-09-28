/** POST /api/jobs/:id/publish — deposit budgetMax, flip draft → open */
import { route } from '../../../../lib/route.ts'
import { writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { publishJob } from '../../../../modules/jobs.ts'

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return publishJob(request, params.id)
})
