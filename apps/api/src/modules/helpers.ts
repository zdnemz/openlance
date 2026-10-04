/** Shared module helpers: participant guards + common loads. */
import { and, eq, or } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { Errors } from '../lib/errors.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { fundingMatches, uuidToBytes32 } from '../chain/events.ts'
import { logger } from '../lib/logger.ts'
import { disputes, jobs, projectMilestones, projects, proposals, users } from '../db/schema.ts'
import type { Job, Project, ProjectMilestone, User } from '../db/schema.ts'

export async function loadProject(projectId: string): Promise<Project> {
  const [p] = await getDb().select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!p) throw Errors.notFound('Project')
  return p
}

/** The authenticated user must be the client or the freelancer on the project. */
export async function requireParticipant(projectId: string, user: User): Promise<Project> {
  const p = await loadProject(projectId)
  if (p.clientId !== user.id && p.freelancerId !== user.id) {
    throw Errors.forbidden('Only project participants may access this')
  }
  return p
}

/**
 * Read guard for the project room: participants always, plus arbiters seated
 * on the project (`chosenArbiters`) or selected on an open dispute round.
 * Mutations keep using `requireParticipant` — this only opens the read model
 * so assigned arbiters get milestone/dispute context for voting.
 */
export async function requireParticipantOrArbiter(projectId: string, user: User): Promise<Project> {
  const p = await loadProject(projectId)
  if (p.clientId === user.id || p.freelancerId === user.id) return p
  const me = user.walletAddress.toLowerCase()
  const seats = Array.isArray(p.chosenArbiters) ? (p.chosenArbiters as unknown[]).map(String) : []
  if (seats.some((a) => a.toLowerCase() === me)) return p
  const open = await getDb().select({ status: disputes.status, selectedArbiters: disputes.selectedArbiters })
    .from(disputes).where(eq(disputes.projectId, p.id)).limit(20)
  for (const d of open) {
    if (d.status === 'resolved') continue
    const list = Array.isArray(d.selectedArbiters) ? (d.selectedArbiters as unknown[]).map(String) : []
    if (list.some((a) => a.toLowerCase() === me)) return p
  }
  throw Errors.forbidden('Only project participants and assigned arbiters may access this')
}

export async function loadMilestone(milestoneId: string): Promise<{ milestone: ProjectMilestone; project: Project }> {
  const [m] = await getDb().select().from(projectMilestones).where(eq(projectMilestones.id, milestoneId)).limit(1)
  if (!m) throw Errors.notFound('Milestone')
  const project = await loadProject(m.projectId)
  return { milestone: m, project }
}

export async function loadJob(jobId: string): Promise<Job> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  if (!job) throw Errors.notFound('Job')
  return job
}

/**
 * Read guard for a file attached to a proposal (a bid's supporting material).
 * Deliberately not `requireParticipant`: a proposal has no project yet, and its
 * audience is the job's poster — who is deciding between bids and must be able
 * to read what each one attaches — plus the freelancer who bid.
 */
export async function requireProposalReader(proposalId: string, user: User): Promise<void> {
  const [row] = await getDb()
    .select({ freelancerId: proposals.freelancerId, posterId: jobs.posterId })
    .from(proposals)
    .innerJoin(jobs, eq(jobs.id, proposals.jobId))
    .where(eq(proposals.id, proposalId))
    .limit(1)
  if (!row) throw Errors.notFound('Proposal')
  if (user.id !== row.freelancerId && user.id !== row.posterId) {
    throw Errors.forbidden('Only the job poster and the bidding freelancer may read this file')
  }
}

/** The two wallets a project's funding must name: client pays, freelancer is paid. */
export async function projectWallets(q: Pick<ReturnType<typeof getDb>, 'select'>, projectId: string): Promise<{ client: string; freelancer: string } | null> {
  const [p] = await q.select({ clientId: projects.clientId, freelancerId: projects.freelancerId }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!p) return null
  const rows = await q.select({ id: users.id, wallet: users.walletAddress }).from(users).where(or(eq(users.id, p.clientId), eq(users.id, p.freelancerId)))
  const client = rows.find((r) => r.id === p.clientId)?.wallet
  const freelancer = rows.find((r) => r.id === p.freelancerId)?.wallet
  return client && freelancer ? { client, freelancer } : null
}

export async function isParticipant(projectId: string, userId: string): Promise<boolean> {
  const rows = await getDb().select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), or(eq(projects.clientId, userId), eq(projects.freelancerId, userId))))
    .limit(1)
  return rows.length > 0
}

/**
 * Resolve-on-write: the mirror can miss the funding (indexer gap), leaving
 * onchainId NULL while the milestone is funded on-chain. `ref` is an indexed
 * log topic, so one getLogs finds the funding and repairs the row — chain
 * wins. Returns the (possibly repaired) row; backfilled=false means nothing
 * changed (already had an id, mock mode, or never funded on-chain).
 */
export async function ensureMilestoneOnchain(milestone: ProjectMilestone): Promise<{ milestone: ProjectMilestone; backfilled: boolean }> {
  if (milestone.onchainId !== null) return { milestone, backfilled: false }
  const adapter = getChainAdapter()
  if (adapter.mode !== 'real') return { milestone, backfilled: false }
  const wallets = await projectWallets(getDb(), milestone.projectId)
  if (!wallets) return { milestone, backfilled: false }
  // First funding that actually pays THIS milestone — a ref match alone is
  // permissionless (see fundingMatches).
  const found = (await adapter.findFundingsByRef(uuidToBytes32(milestone.id)).catch(() => []))
    .find((f) => fundingMatches(f, { ...wallets, amountWei: milestone.amountWei }))
  if (!found) return { milestone, backfilled: false }

  // `onchain_id` is UNIQUE, and the id is only unique WITHIN a chain: a redeploy
  // restarts milestone ids at 1, so a mirror row from the previous chain can still
  // own the id this funding actually used. That made this write throw, and the
  // throw escaped as an unhandled 500 — the exact opposite of what resolve-on-write
  // promises ("landed work is never bricked"), and the message a freelancer got was
  // a raw SQL dump naming a constraint they have no way to act on.
  //
  // So the conflict is detected here and named. It is not repairable from this
  // request: two rows cannot both be milestone 1, and guessing which one is right
  // would be worse than refusing. `chain/generation.ts` clears the stale claim when
  // the whole mirror belongs to a dead chain, which is the usual cause.
  const db = getDb()
  const [holder] = await db
    .select({ id: projectMilestones.id, chainStatus: projectMilestones.chainStatus })
    .from(projectMilestones)
    .where(eq(projectMilestones.onchainId, found.milestoneId))
    .limit(1)
  if (holder && holder.id !== milestone.id) {
    logger.warn('chain mirror conflict — onchain id already claimed', {
      milestoneId: milestone.id,
      onchainId: found.milestoneId,
      claimedBy: holder.id,
      claimedByStatus: holder.chainStatus,
      fundingTxHash: found.txHash,
    })
    throw Errors.conflict(
      'chain_mirror_conflict',
      'This milestone is funded on-chain, but its on-chain id is already claimed by another milestone — the chain was redeployed while the database kept the previous mirror. Rebuild the chain mirror (pnpm db:flush) and retry.',
    )
  }

  const live = await adapter.getMilestoneStatus(found.milestoneId).catch(() => null)
  // Backstop for the race the pre-check cannot close: two concurrent requests can
  // both pass it, and only the database is authoritative. 23505 is
  // unique_violation; re-read so the caller sees the winner's row rather than an
  // exception.
  let updated: typeof projectMilestones.$inferSelect | undefined
  try {
    ;[updated] = await db.update(projectMilestones).set({
      onchainId: found.milestoneId,
      chainStatus: live ?? 'funded',
      fundedTxHash: found.txHash,
      fundedAt: found.blockTime,
      updatedAt: new Date(),
    }).where(eq(projectMilestones.id, milestone.id)).returning()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    throw Errors.conflict(
      'chain_mirror_conflict',
      'Another request claimed this milestone\'s on-chain id first. Retry.',
    )
  }
  return { milestone: updated!, backfilled: true }
}

/** Postgres 23505 — true unique constraint violation, not any driver-shaped error. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}
