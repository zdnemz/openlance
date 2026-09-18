/**
 * /dev/chain — mock-chain control surface (CHAIN_MODE=mock only, never mounted
 * in production). These endpoints REPLACE wallet transactions during the
 * backend-first phase: every call runs the same event → indexer → mirror →
 * outbox pipeline a real tx would, so the frontend is built against the real
 * API shape and simply swaps in wallet txs when the contracts deploy.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { Errors } from '../lib/errors'
import { getMockAdapter } from '../chain/adapter'
import { uuidToBytes32 } from '../chain/events'
import { users, type User } from '../db/schema'
import { loadMilestone } from './helpers'
import type { ProjectMilestone } from '../db/schema'

export const devChainRoutes = new Hono()

devChainRoutes.use('*', async (_c, next) => {
  if (env.NODE_ENV === 'production' || env.chainMode !== 'mock') {
    throw Errors.notFound('Route')
  }
  await next()
})

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

async function walletsFor(milestone: ProjectMilestone): Promise<{ client: User; freelancer: User }> {
  const db = await getDb()
  const { loadProject } = await import('./helpers')
  const project = await loadProject(milestone.projectId)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  if (!client || !freelancer) throw Errors.internal('Project participants missing')
  return { client, freelancer }
}

function requireOnchainId(m: ProjectMilestone): number {
  if (!m.onchainId) throw Errors.precondition('not_funded', 'Milestone is not funded on-chain yet')
  return m.onchainId
}

devChainRoutes.get('/state', async (c) => {
  return ok(c, await getMockAdapter().snapshot())
})

devChainRoutes.post('/register-arbiter', async (c) => {
  const body = await validate(c, z.object({ address: ADDRESS }).strict())
  const log = await getMockAdapter().registerArbiter(body.address)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/deregister-arbiter', async (c) => {
  const body = await validate(c, z.object({ address: ADDRESS }).strict())
  const log = await getMockAdapter().deregisterArbiter(body.address)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/fund', async (c) => {
  const body = await validate(c, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client, freelancer } = await walletsFor(milestone)
  const log = await getMockAdapter().fund(
    uuidToBytes32(milestone.id),
    body.by ?? client.walletAddress,
    freelancer.walletAddress,
    milestone.amountWei,
  )
  return ok(c, { txHash: log.txHash, block: log.blockNumber, onchainId: log.args.milestoneId }, 201)
})

devChainRoutes.post('/submit', async (c) => {
  const body = await validate(c, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { freelancer } = await walletsFor(milestone)
  const log = await getMockAdapter().submit(requireOnchainId(milestone), body.by ?? freelancer.walletAddress)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/approve', async (c) => {
  const body = await validate(c, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client } = await walletsFor(milestone)
  const log = await getMockAdapter().approve(requireOnchainId(milestone), body.by ?? client.walletAddress)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/cancel', async (c) => {
  const body = await validate(c, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client } = await walletsFor(milestone)
  const log = await getMockAdapter().cancel(requireOnchainId(milestone), body.by ?? client.walletAddress)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/dispute', async (c) => {
  const body = await validate(c, z.object({ milestoneId: z.string().uuid(), by: ADDRESS }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const log = await getMockAdapter().dispute(requireOnchainId(milestone), body.by)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})

devChainRoutes.post('/resolve', async (c) => {
  const body = await validate(c, z.object({
    milestoneId: z.string().uuid(),
    arbiter: ADDRESS,
    outcome: z.enum(['release', 'refund', 'split']),
    withinSla: z.boolean().default(true),
  }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const logs = await getMockAdapter().resolve(requireOnchainId(milestone), body.arbiter, body.outcome, body.withinSla)
  return ok(c, { txHashes: logs.map((l) => l.txHash), block: logs.at(-1)?.blockNumber }, 201)
})

devChainRoutes.post('/withdraw-fees', async (c) => {
  const body = await validate(c, z.object({ to: ADDRESS }).strict())
  const log = await getMockAdapter().withdrawFees(body.to)
  return ok(c, { txHash: log.txHash, block: log.blockNumber }, 201)
})
