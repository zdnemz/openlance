/** GET /api/jobs/:id/proposals · POST /api/jobs/:id/proposals */
import { route, created } from '../../../../lib/route.ts'
import { readRateLimit, writeRateLimit } from '../../../../lib/rate-limit.ts'
import { requireAuth } from '../../../../auth/middleware.ts'
import { createProposal, listProposals } from '../../../../modules/proposals.ts'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProposals(request, params.id)
})

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return created(await createProposal(request, params.id))
})
