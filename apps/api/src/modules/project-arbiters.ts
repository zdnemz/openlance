/**
 * Mutual arbiter lock (propose → approve → lock, exactly 3).
 *
 * After award, either side proposes 3 registry addresses; the other side
 * approves and the list locks on the project. At dispute open the UI passes
 * the locked list to `openDisputeWith`, which seats exactly that panel — an
 * arbiter the parties dropped is never re-seated. A panel that cannot staff
 * the round (everyone benched since the lock) falls back to random selection
 * on-chain, so a stale pick can never brick a dispute.
 *
 * The panel is all-or-nothing because the round is never topped up: locking 1
 * would decide a live dispute on a single voice, locking 2 on two that must
 * BOTH reveal. A full 3 keeps the 2-of-3 quorum. A project with fewer than 3
 * eligible arbiters in the roster cannot lock one at all and falls back to the
 * random draw at dispute time.
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

/** Mirrors Escrow.MAX_ARBITERS — the full panel, and the only lockable size. */
const PANEL_SIZE = 3

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
  // The single gate for panel size: `propose` runs it on the nominee list, and
  // `approve` re-runs it on the stored proposal, so a row that predates this
  // rule (or was written by an older client) still cannot lock a partial panel.
  if (normalized.length !== PANEL_SIZE) {
    throw Errors.badRequest(
      `Arbiter panel must be exactly ${PANEL_SIZE} — a locked panel is the dispute panel and is never topped up`,
    )
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
