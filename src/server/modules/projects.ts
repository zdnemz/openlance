/** /projects — participant-scoped views of awarded work (PRD §6). */
import { desc, eq, or } from 'drizzle-orm'
import { getDb } from '../db'
import { pagination } from '../lib/http'
import { requireAuth } from '../auth/middleware'
import { toEth } from '../lib/money'
import { getChainAdapter } from '../chain/adapter'
import { uuidToBytes32 } from '../chain/events'
import { env } from '../config'
import { projectMilestones, projects, reviews, users } from '../db/schema'
import { requireParticipant } from './helpers'

function milestoneView(m: typeof projectMilestones.$inferSelect, withTxHints: boolean) {
  const view: Record<string, unknown> = {
    id: m.id,
    projectId: m.projectId,
    position: m.position,
    title: m.title,
    description: m.description,
    amountWei: m.amountWei,
    amountEth: toEth(m.amountWei),
    onchainId: m.onchainId,
    chainStatus: m.chainStatus,
    softStatus: m.softStatus,
    fundedAt: m.fundedAt,
    submittedAt: m.submittedAt,
    settledAt: m.settledAt,
    settlementTxHash: m.settlementTxHash,
    // funding payload for the wallet: ref travels inside the fund() tx so the
    // indexer can map the on-chain milestone back to this row.
    ...(withTxHints ? { fund: { contract: getChainAdapter().escrowAddress, chainId: env.CHAIN_ID, ref: uuidToBytes32(m.id), amountWei: m.amountWei } } : {}),
  }
  return view
}

export async function listProjects(request: Request) {
  const user = await requireAuth(request)
  const { limit, offset } = pagination(new URL(request.url))
  const db = getDb()
  const rows = await db.select().from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
    .orderBy(desc(projects.createdAt)).limit(limit).offset(offset)
  return rows
}

export async function getProject(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const db = getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  return {
    ...project,
    client: { id: client!.id, walletAddress: client!.walletAddress, displayName: client!.displayName },
    freelancer: { id: freelancer!.id, walletAddress: freelancer!.walletAddress, displayName: freelancer!.displayName },
    milestones: ms.map((m) => milestoneView(m, true)),
  }
}

export async function listProjectMilestones(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const db = getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  return ms.map((m) => milestoneView(m, true))
}

export async function listProjectReviews(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const db = getDb()
  const ms = await db.select({ id: projectMilestones.id }).from(projectMilestones)
    .where(eq(projectMilestones.projectId, project.id))
  const ids = ms.map((m) => m.id)
  if (ids.length === 0) return []
  const rows = await db.select().from(reviews).orderBy(desc(reviews.createdAt)).limit(200)
  return rows.filter((r) => ids.includes(r.milestoneId))
}
