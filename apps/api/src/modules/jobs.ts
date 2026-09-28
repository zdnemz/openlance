/** /jobs domain logic — draft → deposit → publish (PRD F1). */
import { and, count, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { env } from '../config.ts'
import { pagination, validate } from '../lib/http.ts'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { isValidEthAmount, toWei, toEth } from '../lib/money.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { jobMilestones, jobs, projects, users } from '../db/schema.ts'
import { loadJobWithTemplate } from './helpers.ts'

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
  budget: z.string().refine(isValidEthAmount, 'Invalid ETH amount'),
  milestones: z.array(milestoneInput).min(1).max(20),
}).strict()

export function jobView(job: typeof jobs.$inferSelect, template: (typeof jobMilestones.$inferSelect)[], poster?: typeof users.$inferSelect, projectId: string | null = null) {
  return {
    id: job.id,
    // The awarded project, if any (null until a proposal is accepted).
    projectId,
    // bytes32 of the job uuid — the lockBudget key (drawdown model).
    jobRef: uuidToBytes32(job.id),
    title: job.title,
    description: job.description,
    category: job.category,
    skills: job.skills,
    status: job.status,
    budget: { minWei: job.budgetMinWei, maxWei: job.budgetMaxWei, minEth: toEth(job.budgetMinWei), maxEth: toEth(job.budgetMaxWei) },
    poster: poster ? publicPoster(poster) : undefined,
    milestones: template.map((m) => ({ id: m.id, position: m.position, title: m.title, description: m.description, amountWei: m.amountWei, amountEth: toEth(m.amountWei) })),
    templateTotalWei: template.reduce((acc, m) => acc + BigInt(m.amountWei), 0n).toString(),
    deposit: job.depositAmountWei ? { amountWei: job.depositAmountWei, txHash: job.depositTxHash, depositedAt: job.depositedAt } : null,
    publishedAt: job.publishedAt,
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
  const items = await Promise.all(rows.map(async (j) => jobView(j, await templateFor(j.id), posters.find((p) => p.id === j.posterId), projectByJob.get(j.id) ?? null)))
  return { items, total, limit, offset }
}

// ── Create (always a private draft — publish needs the deposit gate) ─────────
export async function createJob(request: Request) {
  const user = await requireRole(request, ['client'])
  await requireKyc(request)
  const body = await validate(request, createJobSchema)
  const total = body.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n)
  if (total !== BigInt(toWei(body.budget))) {
    throw Errors.badRequest(`Milestone template total (${toEth(total.toString())} ETH) must equal the fixed budget`)
  }

  const db = getDb()
  const job = await db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({
      posterId: user.id,
      title: body.title,
      description: body.description,
      category: body.category,
      skills: body.skills,
      // Fixed rate: min == max == budget. Both columns stay so the read model,
      // the bid ceiling and the surplus-refund math in proposals.ts stay valid.
      budgetMinWei: toWei(body.budget),
      budgetMaxWei: toWei(body.budget),
      status: 'draft',
    }).returning()
    await tx.insert(jobMilestones).values(body.milestones.map((m, i) => ({
      jobId: job!.id, position: i + 1, title: m.title, description: m.description, amountWei: toWei(m.amount),
    })))
    return job!
  })
  return jobView(job, await templateFor(job.id))
}

// ── Read (drafts are poster-only) ───────────────────────────────────────────
export async function getJob(jobId: string, request?: Request) {
  const { job, template } = await loadJobWithTemplate(jobId)
  const db = getDb()
  const [poster] = await db.select().from(users).where(eq(users.id, job.posterId)).limit(1)
  if (job.status === 'draft') {
    const user = await requireKyc(request!)
    if (job.posterId !== user.id) throw Errors.forbidden('Draft jobs are private to the poster')
  }
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.jobId, job.id)).limit(1)
  return jobView(job, template, poster, project?.id ?? null)
}

// ── Publish (poster only, from draft — deposit of budgetMax is the gate) ────
export async function publishJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may publish this job')
  if (job.status !== 'draft') throw Errors.conflict('job_not_draft', 'Only draft jobs can be published')
  const body = await validate(request, z.object({ depositTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict())
  await verifyDeposit(body.depositTxHash, user.walletAddress, job.budgetMaxWei, uuidToBytes32(job.id))
  const now = new Date()
  const db = getDb()
  const [updated] = await db.update(jobs).set({
    status: 'open', depositAmountWei: job.budgetMaxWei, depositTxHash: body.depositTxHash,
    depositedAt: now, publishedAt: now, updatedAt: now,
  }).where(eq(jobs.id, job.id)).returning()
  return jobView(updated!, await templateFor(updated!.id))
}

/**
 * The publish gate: in real mode the deposit must be a successful
 * `lockBudget(jobRef)` call on the escrow contract, carrying exactly the budget
 * from the poster, for THIS job — the funds then back every milestone via
 * fundFromCredit (drawdown model). Mock mode (no chain to read) accepts the
 * hash shape alone; real mode without an escrow address is a hard error.
 */
async function verifyDeposit(txHash: string, poster: string, budgetWei: string, jobRef: string) {
  if (env.chainMode !== 'real' || !env.CHAIN_RPC_URL) return
  if (!env.ESCROW_ADDRESS) throw Errors.precondition('escrow_unconfigured', 'Escrow contract is not configured')
  const { createPublicClient, http, decodeFunctionData } = await import('viem')
  const { ESCROW_ABI } = await import('../chain/abi.ts')
  const client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash as `0x${string}` }).catch(() => null),
    client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null),
  ])
  if (!tx || !receipt || receipt.status !== 'success') throw Errors.badRequest('Deposit transaction not found or failed')
  if (tx.from.toLowerCase() !== poster.toLowerCase()) throw Errors.badRequest('Deposit must come from the poster wallet')
  if ((tx.to ?? '').toLowerCase() !== env.ESCROW_ADDRESS.toLowerCase()) throw Errors.badRequest('Deposit must go to the escrow contract')
  if (tx.value.toString() !== budgetWei) throw Errors.badRequest('Deposit must equal the budget')
  const decoded = (() => { try { return decodeFunctionData({ abi: ESCROW_ABI, data: tx.input }) } catch { return null } })()
  if (!decoded || decoded.functionName !== 'lockBudget') throw Errors.badRequest('Deposit transaction must call lockBudget')
  if (String(decoded.args?.[0] ?? '').toLowerCase() !== jobRef.toLowerCase()) throw Errors.badRequest('Deposit must lock this job\'s budget')
}

// ── Edit (poster only, while draft — published budgets lock the guarantee) ──
export async function updateJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may edit this job')
  if (job.status !== 'draft') throw Errors.conflict('job_locked', 'Job can only be edited while a draft')

  const body = await validate(request, z.object({
    title: z.string().min(4).max(140).optional(),
    description: z.string().min(20).max(20000).optional(),
    category: z.string().min(2).max(60).optional(),
    skills: z.array(z.string().min(1).max(40)).max(15).optional(),
    budget: z.string().refine(isValidEthAmount).optional(),
    milestones: z.array(milestoneInput).min(1).max(20).optional(),
  }).strict())

  // Fixed-rate invariant: the milestone sum must equal the budget. Re-check on
  // any edit that touches either side (the untouched side is read from disk).
  if (body.budget || body.milestones) {
    const targetBudget = body.budget ? toWei(body.budget) : job.budgetMaxWei
    const amounts = body.milestones ? body.milestones.map((m) => toWei(m.amount)) : (await templateFor(jobId)).map((m) => m.amountWei)
    const sum = amounts.reduce((acc, w) => acc + BigInt(w), 0n)
    if (sum !== BigInt(targetBudget)) {
      throw Errors.badRequest(`Milestone template total (${toEth(sum.toString())} ETH) must equal the fixed budget`)
    }
  }

  const db = getDb()
  const updated = await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (body.title) patch.title = body.title
    if (body.description) patch.description = body.description
    if (body.category) patch.category = body.category
    if (body.skills) patch.skills = body.skills
    if (body.budget) { patch.budgetMinWei = toWei(body.budget); patch.budgetMaxWei = toWei(body.budget) }
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

// ── Cancel (poster only: draft → cancelled; open → cancelled + full vault refund)
export async function cancelJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const { job } = await loadJobWithTemplate(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may cancel this job')
  if (job.status !== 'draft' && job.status !== 'open') throw Errors.conflict('job_locked', 'Only draft or open jobs can be cancelled')
  const db = getDb()
  const [updated] = await db.update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(jobs.id, job.id)).returning()
  return jobView(updated!, await templateFor(updated!.id))
}
