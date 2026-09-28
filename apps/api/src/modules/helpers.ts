/** Shared module helpers: participant guards + common loads. */
import { and, eq, or } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { Errors } from '../lib/errors.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { disputes, jobMilestones, jobs, projectMilestones, projects } from '../db/schema.ts'
import type { Project, ProjectMilestone, User } from '../db/schema.ts'

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

/** Job + its milestone template (positions ordered). */
export async function loadJobWithTemplate(jobId: string) {
  const db = getDb()
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  if (!job) throw Errors.notFound('Job')
  const template = await db.select().from(jobMilestones).where(eq(jobMilestones.jobId, jobId))
  return { job, template: template.sort((a, b) => a.position - b.position) }
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
  const found = await adapter.findFundingByRef(uuidToBytes32(milestone.id)).catch(() => null)
  if (!found) return { milestone, backfilled: false }
  const live = await adapter.getMilestoneStatus(found.milestoneId).catch(() => null)
  const [updated] = await getDb().update(projectMilestones).set({
    onchainId: found.milestoneId,
    chainStatus: live ?? 'funded',
    fundedTxHash: found.txHash,
    fundedAt: found.blockTime,
    updatedAt: new Date(),
  }).where(eq(projectMilestones.id, milestone.id)).returning()
  return { milestone: updated!, backfilled: true }
}
