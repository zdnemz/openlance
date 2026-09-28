/** POST + DELETE /api/projects/:id/milestones/:mid/disputes */
import { route, created, ok } from '../../../../../../lib/route.ts'
import { writeRateLimit } from '../../../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../../../auth/middleware.ts'
import { discardDispute, openDispute } from '../../../../../../modules/disputes.ts'

export const POST = route<{ id: string; mid: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await openDispute(request, params.id, params.mid))
})

/** Discard the zombie record (only when no round exists on-chain). */
export const DELETE = route<{ id: string; mid: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return ok(await discardDispute(request, params.id, params.mid))
})
