/** /jobs domain logic — posting with milestone templates (PRD F1). */
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { pagination, validate } from '../lib/http'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isValidEthAmount, toWei, toEth } from '../lib/money'
import { jobMilestones, jobs, users } from '../db/schema'
import { loadJobWithTemplate } from './helpers'

export const milestoneInput = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  amount: z.string().refine(isValidEthAmount, 'Invalid ETH amount (max 18 decimals)'),
}).strict()

export const createJobSchema = z.object({
  title: z.string().min(4).max(140),
  description: z.string().min(20).max(20000),
  category: z.string().min(2).max(60),
  skills: z.array(z.string().min(1).max(40)).max(15).default([]),
  budgetMin: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  budgetMax: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  milestones: z.array(milestoneInput).min(1).max(20),
}).strict()

export function jobView(job: typeof jobs.$inferSelect, template: (typeof jobMilestones.$inferSelect)[], poster?: typeof users.$inferSelect) {
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    category: job.category,
    skills: job.skills,
    status: job.status,
    budget: { minWei: job.budgetMinWei, maxWei: job.budgetMaxWei, minEth: toEth(job.budgetMinWei), maxEth: toEth(job.budgetMaxWei) },
    poster: poster ? publicPoster(poster) : undefined,
    milestones: template.map((m) => ({ id: m.id, position: m.position, title: m.title, description: m.description, amountWei: m.amountWei, amountEth: toEth(m.amountWei) })),
    templateTotalWei: template.reduce((acc, m) => acc + BigInt(m.amountWei), 0n).toString(),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function publicPoster(u: typeof users.$inferSelect) {
  return { id: u.id, walletAddress: u.walletAddress, displayName: u.displayName, avatarUrl: u.avatarUrl, stats: { completedProjectsAsClient: u.completedProjectsAsClient, totalPaidWei: u.totalPaidWei } }
}

async function templateFor(jobId: string) {
  return (await getDb().select().from(jobMilestones).where(eq(jobMilestones.jobId, jobId)))
    .sort((a, b) => a.position - b.position)
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
  if (status && ['open', 'in_progress', 'completed', 'cancelled'].includes(status)) conditions.push(eq(jobs.status, status as 'open'))
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
  const items = await Promise.all(rows.map(async (j) => jobView(j, await templateFor(j.id), posters.find((p) => p.id === j.posterId))))
  return { items, total, limit, offset }
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createJob(request: Request) {
  const user = await requireRole(request, ['client'])
  await requireKyc(request)
  const body = await validate(request, createJobSchema)
  if (BigInt(toWei(body.budgetMin)) > BigInt(toWei(body.budgetMax))) {
    throw Errors.badRequest('budgetMin must be ≤ budgetMax')
  }
  const total = body.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n)
  if (total < BigInt(toWei(body.budgetMin)) || total > BigInt(toWei(body.budgetMax))) {
    throw Errors.badRequest(`Milestone template total (${toEth(total.toString())} ETH) must be within the budget range`)
  }

  const db = getDb()
  const job = await db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({
      posterId: user.id,
      title: body.title,
      description: body.description,
      category: body.category,
      skills: body.skills,
      budgetMinWei: toWei(body.budgetMin),
      budgetMaxWei: toWei(body.budgetMax),
    }).returning()
    await tx.insert(jobMilestones).values(body.milestones.map((m, i) => ({
      jobId: job!.id, position: i + 1, title: m.title, description: m.description, amountWei: toWei(m.amount),
    })))
    return job!
  })
  return jobView(job, await templateFor(job.id))
}

// ── Read ────────────────────────────────────────────────────────────────────
export async function getJob(jobId: string) {
  const { job, template } = await loadJobWithTemplate(jobId)
  const db = getDb()
  const [poster] = await db.select().from(users).where(eq(users.id, job.posterId)).limit(1)
  return jobView(job, template, poster)
}

// ── Edit (poster only, while open — PRD F1) ────────────────────────────────
export async function updateJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may edit this job')
  if (job.status !== 'open') throw Errors.conflict('job_locked', 'Job can only be edited while open')

  const body = await validate(request, z.object({
    title: z.string().min(4).max(140).optional(),
    description: z.string().min(20).max(20000).optional(),
    category: z.string().min(2).max(60).optional(),
    skills: z.array(z.string().min(1).max(40)).max(15).optional(),
    budgetMin: z.string().refine(isValidEthAmount).optional(),
    budgetMax: z.string().refine(isValidEthAmount).optional(),
    milestones: z.array(milestoneInput).min(1).max(20).optional(),
  }).strict())

  const db = getDb()
  const updated = await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (body.title) patch.title = body.title
    if (body.description) patch.description = body.description
    if (body.category) patch.category = body.category
    if (body.skills) patch.skills = body.skills
    if (body.budgetMin) patch.budgetMinWei = toWei(body.budgetMin)
    if (body.budgetMax) patch.budgetMaxWei = toWei(body.budgetMax)
    const [job] = await tx.update(jobs).set(patch).where(eq(jobs.id, jobId)).returning()

    if (body.milestones) {
      await tx.delete(jobMilestones).where(eq(jobMilestones.jobId, job!.id))
      await tx.insert(jobMilestones).values(body.milestones.map((m, i) => ({
        jobId: job!.id, position: i + 1, title: m.title, description: m.description, amountWei: toWei(m.amount),
      })))
    }
    return job!
  })
  return jobView(updated, await templateFor(updated.id))
}

// ── Cancel (poster only, while open — no funds involved pre-award) ─────────
export async function cancelJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may cancel this job')
  if (job.status !== 'open') throw Errors.conflict('job_locked', 'Only open jobs can be cancelled')
  const db = getDb()
  const [updated] = await db.update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(jobs.id, job.id)).returning()
  return jobView(updated!, await templateFor(updated!.id))
}
