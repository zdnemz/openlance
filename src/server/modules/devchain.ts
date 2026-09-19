/**
 * /dev/chain — mock-chain control surface (CHAIN_MODE=mock only, never in
 * production). These endpoints REPLACE wallet transactions during the
 * backend-first phase: every call runs the same event → indexer → mirror →
 * outbox pipeline a real tx would.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { Errors } from '../lib/errors'
import { getMockAdapter } from '../chain/adapter'
import { uuidToBytes32 } from '../chain/events'
import { users } from '../db/schema'
import { loadMilestone } from './helpers'
import { loadProject } from './helpers'
import type { ProjectMilestone } from '../db/schema'

/** Guard: throw 404 unless the mock chain is active in a non-production env. */
export function assertDevChainEnabled() {
  if (env.NODE_ENV === 'production' || env.chainMode !== 'mock') {
    throw Errors.notFound('Route')
  }
}

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

async function walletsFor(milestone: ProjectMilestone) {
  const db = getDb()
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

export async function devState() {
  assertDevChainEnabled()
  return getMockAdapter().snapshot()
}

export async function devRegisterArbiter(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ address: ADDRESS }).strict())
  const log = await getMockAdapter().registerArbiter(body.address)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devDeregisterArbiter(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ address: ADDRESS }).strict())
  const log = await getMockAdapter().deregisterArbiter(body.address)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devFund(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client, freelancer } = await walletsFor(milestone)
  const log = await getMockAdapter().fund(
    uuidToBytes32(milestone.id),
    body.by ?? client.walletAddress,
    freelancer.walletAddress,
    milestone.amountWei,
  )
  return { txHash: log.txHash, block: log.blockNumber, onchainId: log.args.milestoneId }
}

export async function devSubmit(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { freelancer } = await walletsFor(milestone)
  const log = await getMockAdapter().submit(requireOnchainId(milestone), body.by ?? freelancer.walletAddress)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devApprove(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client } = await walletsFor(milestone)
  const log = await getMockAdapter().approve(requireOnchainId(milestone), body.by ?? client.walletAddress)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devCancel(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { client } = await walletsFor(milestone)
  const log = await getMockAdapter().cancel(requireOnchainId(milestone), body.by ?? client.walletAddress)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devDispute(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const log = await getMockAdapter().dispute(requireOnchainId(milestone), body.by)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devResolve(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({
    milestoneId: z.string().uuid(),
    arbiter: ADDRESS,
    outcome: z.enum(['release', 'refund', 'split']),
    withinSla: z.boolean().default(true),
  }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const logs = await getMockAdapter().resolve(requireOnchainId(milestone), body.arbiter, body.outcome, body.withinSla)
  return { txHashes: logs.map((l) => l.txHash), block: logs.at(-1)?.blockNumber }
}

export async function devWithdrawFees(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ to: ADDRESS }).strict())
  const log = await getMockAdapter().withdrawFees(body.to)
  return { txHash: log.txHash, block: log.blockNumber }
}
