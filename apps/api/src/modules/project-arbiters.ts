/**
 * Mutual arbiter lock (propose → approve → lock, 1–3).
 *
 * After award, either side proposes 1–3 registry addresses; the other side
 * approves and the list locks on the project. At dispute open the UI passes
 * the locked list to `openDisputeWith`, which seats exactly that panel — an
 * arbiter the parties dropped is never re-seated, and a single locked arbiter
 * IS seated rather than topped up. A panel that cannot staff the round (everyone
 * benched since the lock) falls back to random selection on-chain, so a stale
 * pick can never brick a dispute.
 *
 * One locked arbiter is a valid panel: the round is a degraded 1-seat round that
 * decides on that single reveal, rather than a stall. Three keeps the 2-of-3
 * quorum. Two requires BOTH to reveal or the no-quorum fallback refunds the
 * opener — the parties' call, made with both signatures on the lock.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { requireKyc } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { env } from '../config.ts'
import { logger } from '../lib/logger.ts'
import { projects, users } from '../db/schema.ts'
import { loadProject, requireParticipant } from './helpers.ts'

const log = logger.child({ component: 'project-arbiters' })

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid wallet address')

/** Escrow seat bounds: a panel is 1–3, mirroring `Round.arbiterCount`. */
const MIN_PANEL = 1
const MAX_PANEL = 3

async function isRegisteredOnchain(address: string): Promise<boolean | null> {
  if (env.CHAIN_MODE !== 'real' || !env.ARBITER_REGISTRY_ADDRESS || !env.CHAIN_RPC_URL) return null
  try {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
    const registered = await client.readContract({
      address: env.ARBITER_REGISTRY_ADDRESS as `0x${string}`,
      abi: parseAbi(['function isRegistered(address) view returns (bool)']),
      functionName: 'isRegistered',
      args: [address as `0x${string}`],
    }) as boolean
    return registered
  } catch (err) {
    log.warn('arbiter registry read failed — accepting pick optimistically', { err: String(err) })
    return null
  }
}

/**
 * Whether the chain holds this exact panel as the pair's agreement. The lock is
 * only meaningful if `openDisputeWith` will accept it, and that reads
 * `Escrow.agreedPanel`, never this row. null = no chain to ask (mock / outage).
 */
async function panelAgreedOnchain(projectId: string, addresses: string[]): Promise<boolean | null> {
  if (env.chainMode !== 'real' || !env.ESCROW_ADDRESS || !env.CHAIN_RPC_URL) return null
  const db = getDb()
  const project = await loadProject(projectId)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  if (!client || !freelancer) return null
  try {
    const { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters } = await import('viem')
    const chain = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
    const abi = parseAbi(['function pairKey(address,address) pure returns (bytes32)', 'function agreedPanel(bytes32) view returns (bytes32)'])
    const escrow = env.ESCROW_ADDRESS as `0x${string}`
    const key = await chain.readContract({ address: escrow, abi, functionName: 'pairKey', args: [client.walletAddress as `0x${string}`, freelancer.walletAddress as `0x${string}`] })
    const agreed = await chain.readContract({ address: escrow, abi, functionName: 'agreedPanel', args: [key] })
    const padded = [...addresses, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS].slice(0, MAX_PANEL) as `0x${string}`[]
    return agreed === keccak256(encodeAbiParameters([{ type: 'address[3]' }], [padded as [`0x${string}`, `0x${string}`, `0x${string}`]]))
  } catch (err) {
    log.warn('agreed panel read failed', { err: String(err) })
    return null
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

async function validateNominees(projectId: string, addresses: string[]) {
  const db = getDb()
  const project = await loadProject(projectId)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  const parties = new Set([client?.walletAddress.toLowerCase(), freelancer?.walletAddress.toLowerCase()])
  const normalized = addresses.map((a) => a.toLowerCase())
  if (new Set(normalized).size !== normalized.length) throw Errors.badRequest('Duplicate arbiter address')
  // The single gate for panel size: `propose` runs it on the nominee list, and
  // `approve` re-runs it on the stored proposal, so a row written by an older
  // client still cannot lock a panel the contract could never seat.
  if (normalized.length < MIN_PANEL || normalized.length > MAX_PANEL) {
    throw Errors.badRequest(`Arbiter panel must be ${MIN_PANEL}–${MAX_PANEL} arbiters`)
  }
  for (const addr of normalized) {
    if (parties.has(addr)) throw Errors.badRequest('A party cannot arbitrate its own project')
    const registered = await isRegisteredOnchain(addr)
    if (registered === false) throw Errors.badRequest(`Arbiter ${addr} is not registered`)
  }
  return { project, normalized }
}

export async function proposeArbiters(request: Request, projectId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  if (project.status !== 'active') throw Errors.conflict('project_not_active', 'Arbiters can only be picked on active projects')
  if (project.arbitersLockedAt) throw Errors.conflict('arbiters_locked', 'Arbiter list is already locked')
  const body = await validate(request, z.object({ addresses: z.array(ADDRESS).min(1).max(3) }).strict())
  const { normalized } = await validateNominees(projectId, body.addresses)
  const db = getDb()
  const [updated] = await db.update(projects)
    .set({ arbiterProposal: { proposerId: user.id, addresses: normalized }, updatedAt: new Date() })
    .where(eq(projects.id, project.id)).returning()
  return { proposal: updated!.arbiterProposal, locked: updated!.chosenArbiters, lockedAt: updated!.arbitersLockedAt }
}

export async function approveArbiters(request: Request, projectId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  if (project.status !== 'active') throw Errors.conflict('project_not_active', 'Arbiters can only be picked on active projects')
  if (project.arbitersLockedAt) throw Errors.conflict('arbiters_locked', 'Arbiter list is already locked')
  const proposal = project.arbiterProposal as { proposerId: string; addresses: string[] } | null
  if (!proposal?.addresses?.length) throw Errors.conflict('no_proposal', 'No arbiter proposal to approve')
  if (proposal.proposerId === user.id) throw Errors.conflict('self_approve', 'The other party must approve the proposal')
  // Re-validate at lock time: a nominee may have deregistered since proposal.
  await validateNominees(projectId, proposal.addresses)
  // The row must not claim a lock the contract would refuse at dispute time.
  if ((await panelAgreedOnchain(projectId, proposal.addresses)) === false) {
    throw Errors.conflict('panel_not_agreed_onchain', 'Accept the panel on-chain first — a dispute only seats a panel both wallets agreed there')
  }
  const now = new Date()
  const db = getDb()
  const [updated] = await db.update(projects)
    .set({ chosenArbiters: proposal.addresses, arbiterProposal: null, arbitersLockedAt: now, updatedAt: now })
    .where(eq(projects.id, project.id)).returning()
  return { locked: updated!.chosenArbiters, lockedAt: updated!.arbitersLockedAt }
}

/**
 * Reject the pending proposal — the counterparty's veto. Clears the proposal so
 * the parties are back to "nothing picked" and can propose again. Symmetric with
 * approve: only the party who did NOT propose may reject.
 */
export async function rejectArbiters(request: Request, projectId: string) {
  const user = await requireKyc(request)
  const project = await requireParticipant(projectId, user)
  if (project.status !== 'active') throw Errors.conflict('project_not_active', 'Arbiters can only be picked on active projects')
  if (project.arbitersLockedAt) throw Errors.conflict('arbiters_locked', 'Arbiter list is already locked')
  const proposal = project.arbiterProposal as { proposerId: string; addresses: string[] } | null
  if (!proposal?.addresses?.length) throw Errors.conflict('no_proposal', 'No arbiter proposal to reject')
  if (proposal.proposerId === user.id) throw Errors.conflict('self_reject', 'The other party must reject the proposal')
  const db = getDb()
  const [updated] = await db.update(projects)
    .set({ arbiterProposal: null, updatedAt: new Date() })
    .where(eq(projects.id, project.id)).returning()
  return { proposal: updated!.arbiterProposal, locked: updated!.chosenArbiters, lockedAt: updated!.arbitersLockedAt }
}
