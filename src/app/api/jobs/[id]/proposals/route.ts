/** GET /api/jobs/:id/proposals · POST /api/jobs/:id/proposals */
import { route } from '@/server/lib/route'
import { readRateLimit, writeRateLimit } from '@/server/lib/rate-limit'
import { requireAuth } from '@/server/auth/middleware'
import { createProposal, listProposals } from '@/server/modules/proposals'

export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await readRateLimit(request, user.id)
  return listProposals(request, params.id)
})

export const POST = route<{ id: string }>(async (request, { params }) => {
  const user = await requireAuth(request)
  await writeRateLimit(request, user.id)
  return createProposal(request, params.id)
})
