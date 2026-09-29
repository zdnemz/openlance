/** /jobs domain logic — draft → publish → award (PRD F1). */
import { and, count, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { pagination, validate } from '../lib/http.ts'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { isValidEthAmount, toWei, toEth } from '../lib/money.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { jobs, projects, users } from '../db/schema.ts'
import { loadJob } from './helpers.ts'

/**
 * A job post is a brief and a ceiling — nothing else. The milestone breakdown
 * belongs to the freelancer bidding on it (proposalSchema in proposals.ts), so
 * `budget` is the only money field here: it becomes budgetMaxWei, the cap every
 * bid is checked against, and budgetMinWei stays 0 because the price isn't fixed
 * until a bid is accepted.
 */
export const createJobSchema = z.object({
  title: z.string().min(4).max(140),
  description: z.string().min(20).max(20000),
  category: z.string().min(2).max(60),
  skills: z.array(z.string().min(1).max(40)).max(15).default([]),
  budget: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
}).strict()

export function jobView(job: typeof jobs.$inferSelect, poster?: typeof users.$inferSelect, projectId: string | null = null) {
  return {
    id: job.id,
    // The awarded project, if any (null until a proposal is accepted).
    projectId,
    // bytes32 of the job uuid — the drawdown key the escrow locks the budget under.
    jobRef: uuidToBytes32(job.id),
    title: job.title,
    description: job.description,
    category: job.category,
    skills: job.skills,
    status: job.status,
    budget: { maxWei: job.budgetMaxWei, maxEth: toEth(job.budgetMaxWei) },
    poster: poster ? publicPoster(poster) : undefined,
    /** The amount locked on-chain for this job — the winning bid, set at award. */
    funded: job.depositAmountWei ? { amountWei: job.depositAmountWei, txHash: job.depositTxHash, fundedAt: job.depositedAt } : null,
    publishedAt: job.publishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function publicPoster(u: typeof users.$inferSelect) {
  return { id: u.id, walletAddress: u.walletAddress, displayName: u.displayName, avatarUrl: u.avatarUrl, stats: { completedProjectsAsClient: u.completedProjectsAsClient, totalPaidWei: u.totalPaidWei } }
}

// ── List + search ───────────────────────────────────────────────────────────
export async function listJobs(request: Request) {
  const url = new URL(request.url)
  const { limit, offset } = pagination(url)
  const status = url.searchParams.get('status')
  const category = url.searchParams.get('category')
  const skill = url.searchParams.get('skill')
  const q = url.searchParams.get('q')
  const db = getDb()

  const conditions: import('drizzle-orm').SQL[] = []
  if (status && ['draft', 'open', 'in_progress', 'completed', 'cancelled'].includes(status)) conditions.push(eq(jobs.status, status as 'open'))
  // Drafts are private: the marketplace never lists them unless explicitly asked.
  else if (!status) conditions.push(ne(jobs.status, 'draft'))
  if (status === 'draft') {
    // Draft listing is poster-scoped: you only ever see your own drafts.
    const viewer = await requireAuth(request).catch(() => null)
    if (!viewer) throw Errors.unauthorized()
    conditions.push(eq(jobs.posterId, viewer.id))
  }
  if (category) conditions.push(eq(jobs.category, category))
  if (skill) conditions.push(sql`${skill} = ANY(${jobs.skills})`)
  if (q) conditions.push(ilike(jobs.title, `%${q}%`))
  const where = conditions.length ? and(...conditions) : undefined

  const rows = await db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(limit).offset(offset)
  const [{ total }] = await db.select({ total: count() }).from(jobs).where(where)

  const posterIds = [...new Set(rows.map((r) => r.posterId))]
  const posters = posterIds.length
    ? await db.select().from(users).where(inArray(users.id, posterIds))
    : []
  // One batched lookup — the awarded project per listed job (usually none).
  const projs = rows.length
    ? await db.select({ jobId: projects.jobId, id: projects.id }).from(projects).where(inArray(projects.jobId, rows.map((r) => r.id)))
    : []
  const projectByJob = new Map(projs.map((p) => [p.jobId, p.id]))
  const items = rows.map((j) => jobView(j, posters.find((p) => p.id === j.posterId), projectByJob.get(j.id) ?? null))
  return { items, total, limit, offset }
}

// ── Create (always a private draft; publishing is a no-chain visibility flip) ─
export async function createJob(request: Request) {
  const user = await requireRole(request, ['client'])
  await requireKyc(request)
  const body = await validate(request, createJobSchema)

  const [job] = await getDb().insert(jobs).values({
    posterId: user.id,
    title: body.title,
    description: body.description,
    category: body.category,
    skills: body.skills,
    // The client states a ceiling, not a price. min stays 0 so the `max >= min`
    // check and the budget_max listing filters keep working unchanged.
    budgetMinWei: '0',
    budgetMaxWei: toWei(body.budget),
    status: 'draft',
  }).returning()
  return jobView(job!)
}

// ── Read (drafts are poster-only) ───────────────────────────────────────────
export async function getJob(jobId: string, request?: Request) {
  const job = await loadJob(jobId)
  const db = getDb()
  const [poster] = await db.select().from(users).where(eq(users.id, job.posterId)).limit(1)
  if (job.status === 'draft') {
    const user = await requireKyc(request!)
    if (job.posterId !== user.id) throw Errors.forbidden('Draft jobs are private to the poster')
  }
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.jobId, job.id)).limit(1)
  return jobView(job, poster, project?.id ?? null)
}

// ── Publish (poster only, from draft — no chain call, no funds moved) ───────
export async function publishJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may publish this job')
  if (job.status !== 'draft') throw Errors.conflict('job_not_draft', 'Only draft jobs can be published')
  const now = new Date()
  // The budget is escrowed by the award signature (acceptProposal), not here:
  // at publish there is no counterparty, so there is nothing to pay yet.
  const [updated] = await getDb().update(jobs).set({ status: 'open', publishedAt: now, updatedAt: now })
    .where(eq(jobs.id, job.id)).returning()
  return jobView(updated!)
}

// ── Edit (poster only, while draft) ─────────────────────────────────────────
export async function updateJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may edit this job')
  if (job.status !== 'draft') throw Errors.conflict('job_locked', 'Job can only be edited while a draft')

  const body = await validate(request, z.object({
    title: z.string().min(4).max(140).optional(),
    description: z.string().min(20).max(20000).optional(),
    category: z.string().min(2).max(60).optional(),
    skills: z.array(z.string().min(1).max(40)).max(15).optional(),
    budget: z.string().refine(isValidEthAmount).optional(),
  }).strict())

  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (body.title) patch.title = body.title
  if (body.description) patch.description = body.description
  if (body.category) patch.category = body.category
  if (body.skills) patch.skills = body.skills
  if (body.budget) patch.budgetMaxWei = toWei(body.budget)
  const [updated] = await getDb().update(jobs).set(patch).where(eq(jobs.id, jobId)).returning()
  return jobView(updated!)
}

// ── Cancel (poster only: draft → cancelled, open → cancelled) ───────────────
//
// No refund is needed or possible: the budget is only ever locked on-chain by
// the award signature, and a job cancelled before it is awarded never locked one.
export async function cancelJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may cancel this job')
  if (job.status !== 'draft' && job.status !== 'open') throw Errors.conflict('job_locked', 'Only draft or open jobs can be cancelled')
  const [updated] = await getDb().update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(jobs.id, job.id)).returning()
  return jobView(updated!)
}
