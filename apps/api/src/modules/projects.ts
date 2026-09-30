/** /projects — participant-scoped views of awarded work (PRD §6). */
import { desc, eq, inArray, or } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { pagination } from '../lib/http.ts'
import { requireAuth } from '../auth/middleware.ts'
import { toEth } from '../lib/money.ts'
import { Errors } from '../lib/errors.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { env } from '../config.ts'
import { projectMilestones, projects, reviews, users } from '../db/schema.ts'
import { requireParticipant, requireParticipantOrArbiter } from './helpers.ts'

function milestoneView(m: typeof projectMilestones.$inferSelect, withTxHints: boolean, jobRef?: string) {
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
    // The client's "what needs to change" note. Request-changes is off-chain
    // only, so this note IS the whole hand-off — without it in the read model
    // the freelancer is told to revise without being told what to revise.
    softStatusNote: m.softStatusNote,
    fundedAt: m.fundedAt,
    submittedAt: m.submittedAt,
    settledAt: m.settledAt,
    settlementTxHash: m.settlementTxHash,
    withdrawnAt: m.withdrawnAt,
    withdrawTxHash: m.withdrawTxHash,
    // funding payload for the wallet: ref travels inside the fund() tx so the
    // indexer can map the on-chain milestone back to this row. jobRef makes the
    // drawdown call (fundFromCredit) self-contained for the client's wallet.
    ...(withTxHints && jobRef ? {
      fund: {
        contract: getChainAdapter().escrowAddress,
        chainId: env.CHAIN_ID,
        ref: uuidToBytes32(m.id),
        amountWei: m.amountWei,
        jobRef,
      },
    } : {}),
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
  if (rows.length === 0) return []
  // Milestones + parties ride along so list consumers (e.g. the disputes board)
  // get the full ProjectView shape without a per-project fetch.
  const ids = rows.map((p) => p.id)
  const ms = await db.select().from(projectMilestones).where(inArray(projectMilestones.projectId, ids))
  await overlayChainStatus(ms)
  const partyIds = [...new Set(rows.flatMap((p) => [p.clientId, p.freelancerId]))]
  const parties = await db.select().from(users).where(inArray(users.id, partyIds))
  const partyView = (id: string) => {
    const u = parties.find((x) => x.id === id)
    return { id, walletAddress: u?.walletAddress ?? '', displayName: u?.displayName ?? null }
  }
  return rows.map((p) => ({
    ...p,
    client: partyView(p.clientId),
    freelancer: partyView(p.freelancerId),
    milestones: ms
      .filter((m) => m.projectId === p.id)
      .sort((a, b) => a.position - b.position)
      .map((m) => milestoneView(m, true, uuidToBytes32(p.jobId))),
  }))
}

export async function getProject(request: Request, projectId: string) {
  const user = await requireAuth(request)
  // Read-only for assigned arbiters too (they vote from this room's context);
  // every mutation still requires participation.
  const project = await requireParticipantOrArbiter(projectId, user)
  const db = getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  await overlayChainStatus(ms)
  const [client] = await db.select().from(users).where(eq(users.id, project.clientId)).limit(1)
  const [freelancer] = await db.select().from(users).where(eq(users.id, project.freelancerId)).limit(1)
  // A project whose party row is gone used to throw `Cannot read properties of
  // undefined (reading 'id')` → a 500, so the room's "not yours to see" wall
  // never rendered and the user got an opaque server error instead.
  if (!client || !freelancer) throw Errors.notFound('Project party')
  return {
    ...project,
    client: { id: client!.id, walletAddress: client!.walletAddress, displayName: client!.displayName },
    freelancer: { id: freelancer!.id, walletAddress: freelancer!.walletAddress, displayName: freelancer!.displayName },
    milestones: ms.map((m) => milestoneView(m, true, uuidToBytes32(project.jobId))),
  }
}

export async function listProjectMilestones(request: Request, projectId: string) {
  const user = await requireAuth(request)
  const project = await requireParticipant(projectId, user)
  const db = getDb()
  const ms = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)))
    .sort((a, b) => a.position - b.position)
  await overlayChainStatus(ms)
  return ms.map((m) => milestoneView(m, true, uuidToBytes32(project.jobId)))
}

/**
 * On-chain first: every milestone with an onchainId is live-read in real mode
 * (terminal rows included — the read confirms finality rather than assuming
 * the mirror). One `getMilestone` call covers status + escrowed amount, so
 * displayed sums are chain truth too. The DB mirror is fallback only;
 * failures keep the mirror.
 */
async function overlayChainStatus(ms: { onchainId: number | null; chainStatus: string; amountWei: string }[]) {
  const pending = ms.filter((m) => m.onchainId !== null)
  if (pending.length === 0) return
  const adapter = getChainAdapter()
  if (adapter.mode !== 'real') return
  await Promise.all(pending.map(async (m) => {
    const live = await adapter.getMilestoneFull(m.onchainId!).catch(() => null)
    if (!live) return
    m.chainStatus = live.status
    m.amountWei = live.amountWei
  }))
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
