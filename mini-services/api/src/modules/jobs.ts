/** /jobs — posting with milestone templates (PRD F1). */
import { Hono } from 'hono'
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, pagination, validate } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { Errors } from '../lib/errors'
import { isValidEthAmount, toWei, toEth } from '../lib/money'
import { jobMilestones, jobs, users } from '../db/schema'
import { loadJobWithTemplate } from './helpers'

export const jobRoutes = new Hono()

const milestoneInput = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  amount: z.string().refine(isValidEthAmount, 'Invalid ETH amount (max 18 decimals)'),
}).strict()

const createJobSchema = z.object({
  title: z.string().min(4).max(140),
  description: z.string().min(20).max(20000),
  category: z.string().min(2).max(60),
  skills: z.array(z.string().min(1).max(40)).max(15).default([]),
  budgetMin: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  budgetMax: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  milestones: z.array(milestoneInput).min(1).max(20),
}).strict()

function jobView(job: typeof jobs.$inferSelect, template: (typeof jobMilestones.$inferSelect)[], poster?: typeof users.$inferSelect) {
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
  return (await (await getDb()).select().from(jobMilestones).where(eq(jobMilestones.jobId, jobId)))
    .sort((a, b) => a.position - b.position)
}

// ── List + search ───────────────────────────────────────────────────────────
jobRoutes.get('/', readLimiter(), async (c) => {
  const { limit, offset } = pagination(c)
  const status = c.req.query('status')
  const category = c.req.query('category')
  const skill = c.req.query('skill')
  const q = c.req.query('q')
  const db = await getDb()

  const conditions = []
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
  return ok(c, { items, total, limit, offset })
})

// ── Create ──────────────────────────────────────────────────────────────────
jobRoutes.post('/', writeLimiter(), requireAuth, async (c) => {
  const body = await validate(c, createJobSchema)
  if (BigInt(toWei(body.budgetMin)) > BigInt(toWei(body.budgetMax))) {
    throw Errors.badRequest('budgetMin must be ≤ budgetMax')
  }
  // Server-side validation of the milestone template (PRD F1): the amounts
  // must sum inside the declared budget range — checked here, not trusted from the client.
  const total = body.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n)
  if (total < BigInt(toWei(body.budgetMin)) || total > BigInt(toWei(body.budgetMax))) {
    throw Errors.badRequest(`Milestone template total (${toEth(total.toString())} ETH) must be within the budget range`)
  }

  const db = await getDb()
  const job = await db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({
      posterId: getUser(c).id,
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
  return ok(c, jobView(job, await templateFor(job.id)), 201)
})

// ── Read ────────────────────────────────────────────────────────────────────
jobRoutes.get('/:id', readLimiter(), async (c) => {
  const { job, template } = await loadJobWithTemplate(c.req.param('id'))
  const db = await getDb()
  const [poster] = await db.select().from(users).where(eq(users.id, job.posterId)).limit(1)
  return ok(c, jobView(job, template, poster))
})

// ── Edit (poster only, while open — PRD F1) ────────────────────────────────
jobRoutes.patch('/:id', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const { job } = await loadJobWithTemplate(c.req.param('id'))
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may edit this job')
  if (job.status !== 'open') throw Errors.conflict('job_locked', 'Job can only be edited while open')

  const body = await validate(c, z.object({
    title: z.string().min(4).max(140).optional(),
    description: z.string().min(20).max(20000).optional(),
    category: z.string().min(2).max(60).optional(),
    skills: z.array(z.string().min(1).max(40)).max(15).optional(),
    budgetMin: z.string().refine(isValidEthAmount).optional(),
    budgetMax: z.string().refine(isValidEthAmount).optional(),
    milestones: z.array(milestoneInput).min(1).max(20).optional(),
  }).strict())

  const db = await getDb()
  const updated = await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (body.title) patch.title = body.title
    if (body.description) patch.description = body.description
    if (body.category) patch.category = body.category
    if (body.skills) patch.skills = body.skills
    if (body.budgetMin) patch.budgetMinWei = toWei(body.budgetMin)
    if (body.budgetMax) patch.budgetMaxWei = toWei(body.budgetMax)
    const [job] = await tx.update(jobs).set(patch).where(eq(jobs.id, c.req.param('id'))).returning()

    if (body.milestones) {
      await tx.delete(jobMilestones).where(eq(jobMilestones.jobId, job!.id))
      await tx.insert(jobMilestones).values(body.milestones.map((m, i) => ({
        jobId: job!.id, position: i + 1, title: m.title, description: m.description, amountWei: toWei(m.amount),
      })))
    }
    return job!
  })
  return ok(c, jobView(updated, await templateFor(updated.id)))
})

// ── Cancel (poster only, while open — no funds involved pre-award) ─────────
jobRoutes.post('/:id/cancel', writeLimiter(), requireAuth, async (c) => {
  const user = getUser(c)
  const { job } = await loadJobWithTemplate(c.req.param('id'))
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may cancel this job')
  if (job.status !== 'open') throw Errors.conflict('job_locked', 'Only open jobs can be cancelled')
  const db = await getDb()
  const [updated] = await db.update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(jobs.id, job.id)).returning()
  return ok(c, jobView(updated!, await templateFor(updated!.id)))
})
