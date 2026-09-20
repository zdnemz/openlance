/**
 * Mutual arbiter lock (propose → approve → lock, max 3).
 *
 * After award, either side proposes 1–3 registry addresses; the other side
 * approves and the list locks on the project. At dispute open the UI passes
 * the locked list to `openDisputeWith`; anything ineligible falls back to
 * random selection on-chain, so a stale pick can never brick a dispute.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireKyc } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { env } from '../config'
import { logger } from '../lib/logger'
import { projects, users } from '../db/schema'
import { loadProject, requireParticipant } from './helpers'

const log = logger.child({ component: 'project-arbiters' })

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid wallet address')

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

async function validateNominees(projectId: string, addresses: string[]) {
  const db = getDb()
  const project = await loadProject(projectId)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  const parties = new Set([client?.walletAddress.toLowerCase(), freelancer?.walletAddress.toLowerCase()])
  const normalized = addresses.map((a) => a.toLowerCase())
  if (new Set(normalized).size !== normalized.length) throw Errors.badRequest('Duplicate arbiter address')
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
  const now = new Date()
  const db = getDb()
  const [updated] = await db.update(projects)
    .set({ chosenArbiters: proposal.addresses, arbiterProposal: null, arbitersLockedAt: now, updatedAt: now })
    .where(eq(projects.id, project.id)).returning()
  return { locked: updated!.chosenArbiters, lockedAt: updated!.arbitersLockedAt }
}
