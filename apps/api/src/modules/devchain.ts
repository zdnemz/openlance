/**
 * /dev/chain — mock-chain control surface (CHAIN_MODE=mock only, never in
 * production). These endpoints REPLACE wallet transactions during the
 * backend-first phase: every call runs the same event → indexer → mirror →
 * outbox pipeline a real tx would.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../config.ts'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { Errors } from '../lib/errors.ts'
import { getMockAdapter } from '../chain/adapter.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { users } from '../db/schema.ts'
import { loadMilestone } from './helpers.ts'
import { loadProject } from './helpers.ts'
import type { ProjectMilestone } from '../db/schema.ts'

/** Guard: throw 404 unless the mock chain is active in a non-production env. */
export function assertDevChainEnabled() {
  if (env.NODE_ENV !== 'development' || env.chainMode !== 'mock') {
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

export async function devWithdraw(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS.optional() }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const { freelancer } = await walletsFor(milestone)
  const log = await getMockAdapter().withdraw(requireOnchainId(milestone), body.by ?? freelancer.walletAddress)
  return { txHash: log.txHash, block: log.blockNumber }
}

export async function devDispute(request: Request) {
  assertDevChainEnabled()
  const body = await validate(request, z.object({ milestoneId: z.string().uuid(), by: ADDRESS }).strict())
  const { milestone } = await loadMilestone(body.milestoneId)
  const logs = await getMockAdapter().dispute(requireOnchainId(milestone), body.by)
  return { txHashes: logs.map((l) => l.txHash), block: logs.at(-1)?.blockNumber }
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

export async function devWithdrawFees() {
  assertDevChainEnabled()
  const log = await getMockAdapter().withdrawFees()
  return { txHash: log.txHash, block: log.blockNumber }
}

/**
 * Sponsored (gasless) forward, MOCK chain only. Decodes the intended target
 * call from the ForwardRequest `data` and replays it through the same mock
 * adapter the /dev/chain endpoints use — so the full login→sign→relay→indexer
 * path is exercisable with zero infrastructure. The real path lives in
 * backend/chain/relayer.ts (viem → forwarder.execute).
 *
 * `req.value` is always "0" by the time a request reaches here:
 * assertNoSponsoredValue (modules/sponsorship.ts) refuses a value-bearing relay
 * upstream. The value arguments below mirror what the forwarder would do, not
 * a supported sponsored transfer.
 */
export async function devSponsoredFunding(
  req: { to: string; data: string; value: string },
  from: string,
): Promise<string> {
  assertDevChainEnabled()
  const adapter = getMockAdapter()
  const escrow = adapter.escrowAddress.toLowerCase()
  const registry = adapter.registryAddress.toLowerCase()
  const target = req.to.toLowerCase()

  const { decodeFunctionData } = await import('viem')
  const { DEV_ESCROW_WRITE_ABI, DEV_REGISTRY_WRITE_ABI } = await import('../chain/abi.ts')

  if (target === escrow) {
    const { functionName, args } = decodeFunctionData({ abi: DEV_ESCROW_WRITE_ABI, data: req.data as `0x${string}` })
    switch (functionName) {
      case 'fund': {
        const [ref, freelancer] = args as [`0x${string}`, `0x${string}`]
        const log = await adapter.fund(ref, from, freelancer, req.value)
        return log.txHash
      }
      case 'submit': {
        const [onchainId] = args as [bigint]
        return (await adapter.submit(Number(onchainId), from)).txHash
      }
      case 'approve': {
        const [onchainId] = args as [bigint]
        return (await adapter.approve(Number(onchainId), from)).txHash
      }
      case 'cancel': {
        const [onchainId] = args as [bigint]
        return (await adapter.cancel(Number(onchainId), from)).txHash
      }
      case 'withdrawFees': {
        return (await adapter.withdrawFees()).txHash
      }
      default:
        throw Errors.precondition('unsupported_sponsored_call', `Mock sponsorship does not support escrow.${String(functionName)}`)
    }
  }

  if (target === registry) {
    const { functionName } = decodeFunctionData({ abi: DEV_REGISTRY_WRITE_ABI, data: req.data as `0x${string}` })
    switch (functionName) {
      case 'registerArbiter':
        return (await adapter.registerArbiter(from, req.value)).txHash
      case 'requestUnstake':
      case 'withdrawStake':
        return (await adapter.deregisterArbiter(from)).txHash
      default:
        throw Errors.precondition('unsupported_sponsored_call', `Mock sponsorship does not support registry.${String(functionName)}`)
    }
  }

  throw Errors.badRequest('ForwardRequest target is not a known OpenLance contract')
}
