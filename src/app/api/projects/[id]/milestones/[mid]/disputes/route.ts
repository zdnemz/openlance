/** POST + DELETE /api/projects/:id/milestones/:mid/disputes */
import { route, created, ok } from '@/server/lib/route'
import { writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { discardDispute, openDispute } from '@/server/modules/disputes'

export const dynamic = 'force-dynamic'

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
