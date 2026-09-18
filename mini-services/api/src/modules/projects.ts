/** /projects — participant-scoped views of awarded work (PRD §6). */
import { Hono } from 'hono'
import { desc, eq, or } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { ok, pagination } from '../lib/http'
import { readLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { toEth } from '../lib/money'
import { getChainAdapter } from '../chain/adapter'
import { uuidToBytes32 } from '../chain/events'
import { env } from '../config'
import { projectMilestones, projects, reviews, users } from '../db/schema'
import { requireParticipant } from './helpers'

export const projectRoutes = new Hono()

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

projectRoutes.get('/', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const { limit, offset } = pagination(c)
  const db = await getDb()
  const rows = await db.select().from(projects)
    .where(or(eq(projects.clientId, user.id), eq(projects.freelancerId, user.id)))
    .orderBy(desc(projects.createdAt)).limit(limit).offset(offset)
  return ok(c, rows)
})

projectRoutes.get('/:id', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const db = await getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  return ok(c, {
    ...project,
    client: { id: client!.id, walletAddress: client!.walletAddress, displayName: client!.displayName },
    freelancer: { id: freelancer!.id, walletAddress: freelancer!.walletAddress, displayName: freelancer!.displayName },
    milestones: ms.map((m) => milestoneView(m, true)),
  })
})

projectRoutes.get('/:id/milestones', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const db = await getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  return ok(c, ms.map((m) => milestoneView(m, true)))
})

projectRoutes.get('/:id/reviews', readLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const project = await requireParticipant(c.req.param('id'), user)
  const db = await getDb()
  const ms = await db.select({ id: projectMilestones.id }).from(projectMilestones)
    .where(eq(projectMilestones.projectId, project.id))
  const ids = ms.map((m) => m.id)
  if (ids.length === 0) return ok(c, [])
  const rows = await db.select().from(reviews).orderBy(desc(reviews.createdAt)).limit(200)
  return ok(c, rows.filter((r) => ids.includes(r.milestoneId)))
})
