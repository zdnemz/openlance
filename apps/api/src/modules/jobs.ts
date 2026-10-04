/** /jobs domain logic — draft → deposit budgetMax → publish → award (PRD F1). */
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { env } from '../config.ts'
import { pagination, validate } from '../lib/http.ts'
import { requireAuth, requireKyc, requireRole } from '../auth/middleware.ts'
import { Errors } from '../lib/errors.ts'
import { isValidEthAmount, toWei, toEth } from '../lib/money.ts'
import { uuidToBytes32 } from '../chain/events.ts'
import { getChainAdapter } from '../chain/adapter.ts'
import { jobs, projects, users } from '../db/schema.ts'
import { loadJob } from './helpers.ts'

/**
 * A job post is a brief and a ceiling — nothing else. The milestone breakdown
 * belongs to the freelancer bidding on it (proposalSchema in proposals.ts), so
 * `budget` is the only money field here: it becomes budgetMaxWei, which is both
 * the cap every bid is checked against and the amount locked at publish.
 * budgetMinWei stays 0 because the price isn't fixed until a bid is accepted.
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
    /** What is locked on-chain for this job: the ceiling at publish, then the winning bid after award. */
    deposit: job.depositAmountWei ? { amountWei: job.depositAmountWei, txHash: job.depositTxHash, depositedAt: job.depositedAt } : null,
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
  // Default is the marketplace, and the marketplace is open work only: a job
  // leaves it the instant a bid is accepted (in_progress) and never returns.
  else if (!status) conditions.push(eq(jobs.status, 'open'))
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

// ── Create (always a private draft — publish needs the deposit gate) ─────────
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

// ── Publish (poster only, from draft — the deposit of budgetMax is the gate) ─
export async function publishJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may publish this job')
  if (job.status !== 'draft') throw Errors.conflict('job_not_draft', 'Only draft jobs can be published')
  const body = await validate(request, z.object({ depositTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict())
  await verifyDeposit(body.depositTxHash, user.walletAddress, job.budgetMaxWei, uuidToBytes32(job.id))
  const now = new Date()
  // The full ceiling is now escrowed, so every job in the marketplace is
  // funded: a freelancer bidding knows the money is already there. The award
  // draws the bid out of this lock and the remainder stays withdrawable.
  const [updated] = await getDb().update(jobs).set({
    status: 'open', depositAmountWei: job.budgetMaxWei, depositTxHash: body.depositTxHash,
    depositedAt: now, publishedAt: now, updatedAt: now,
  }).where(eq(jobs.id, job.id)).returning()
  return jobView(updated!)
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
  // The transaction proves a lock HAPPENED, not that it is still there: after
  // unlockBudget the same hash re-published an unfunded job. Read the lock now.
  const read = <T>(functionName: 'budgetLocker' | 'lockedBudget' | 'paidOutBudget' | 'reservedBudget') =>
    client.readContract({ address: env.ESCROW_ADDRESS as `0x${string}`, abi: ESCROW_ABI, functionName, args: [jobRef as `0x${string}`] } as never) as Promise<T>
  const [locker, locked, paidOut, reserved] = await Promise.all([
    read<string>('budgetLocker'), read<bigint>('lockedBudget'), read<bigint>('paidOutBudget'), read<bigint>('reservedBudget'),
  ])
  if (locker.toLowerCase() !== poster.toLowerCase() || locked - paidOut - reserved < BigInt(budgetWei)) {
    throw Errors.conflict('deposit_not_live', 'This job\'s budget is no longer locked in escrow — lock it again to publish')
  }
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

// ── Delete (poster only: never awarded, and nothing left locked) ─────────────
//
// A published job's escrow key is bytes32(job.id). Once the row is gone nobody
// can derive that ref again, so any ETH still locked under it becomes
// permanently unwithdrawable. The server therefore re-derives the free balance
// from the chain and refuses while it is non-zero — the client withdraws with
// unlockBudget (the job page's free-budget panel) and deletes after.
//
// The guard is the CHAIN, not the status. A draft can still hold a lock (a
// withdrawal sends an open job back to draft, and one of those may have been
// partial), and a cancelled job keeps its lock until the surplus is taken back,
// so keying this on `status === 'open'` was a way to strand ETH permanently.

/** null = the chain could not be read (mock mode); only real mode has a balance. */
export function deletableByFunding(freeWei: bigint | null): { ok: true } | { ok: false; reason: string; freeWei: string } {
  if (freeWei === null || freeWei === 0n) return { ok: true }
  return { ok: false, reason: 'funding_locked', freeWei: freeWei.toString() }
}

/**
 * An `open` job is a claim that its whole ceiling is escrowed: `publish` locks
 * it, and every bid is capped against it. The client can pull that lock back
 * with `unlockBudget` straight from the wallet, so the free balance — never the
 * status — is what says whether the claim still holds, and a partial withdrawal
 * counts because the ceiling is then uncovered too.
 *
 * null = the chain could not be read; unknown is not unfunded, so a flaky RPC
 * never unpublishes a funded job.
 */
export function fundedForCeiling(freeWei: bigint | null, ceilingWei: bigint): boolean {
  return freeWei === null || freeWei >= ceilingWei
}

/**
 * The publish record a withdrawal invalidates: the lock, and when it landed.
 * One shape, so the streaming applier (the indexer, reacting to the log) and
 * the nightly repair (reconcile, re-reading the chain) can never disagree about
 * what an unfunded job looks like.
 */
export const UNPUBLISHED = {
  status: 'draft', depositAmountWei: null, depositTxHash: null,
  depositedAt: null, publishedAt: null,
} as const

export async function deleteJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may delete this job')
  // An awarded job is a project, and the project is the audit trail for live
  // milestones, disputes and reviews. `projects.job_id` is NO ACTION anyway, so
  // this is a clear refusal instead of a foreign-key error.
  if (job.status === 'in_progress' || job.status === 'completed') {
    throw Errors.conflict('job_awarded', 'An awarded job cannot be deleted — cancel or let it complete')
  }

  const budget = await getChainAdapter().getJobBudget(uuidToBytes32(job.id))
  if (budget === null && env.chainMode === 'real') {
    throw Errors.precondition('chain_unavailable', 'Could not read the locked budget — try again')
  }
  const verdict = deletableByFunding(budget === null ? null : BigInt(budget.freeWei))
  if (!verdict.ok) {
    throw Errors.conflict(verdict.reason, `Withdraw the locked ${toEth(verdict.freeWei)} ETH first, then delete this job`)
  }

  // Proposals (and their attachments) cascade with the job.
  await getDb().delete(jobs).where(eq(jobs.id, job.id))
  return { deleted: true, id: job.id }
}

// ── Cancel (poster only: draft → cancelled; open → cancelled + full vault refund)
//
// The old comment here claimed "open → cancelled + full vault refund". No refund
// happens in this handler, and none is needed: the budget is still locked in the
// Escrow, so the job's free balance becomes withdrawable and the existing
// SurplusPanel calls unlockBudget(jobRef, free) from the poster's wallet. This
// handler only flips off-chain state.
export async function cancelJob(request: Request, jobId: string) {
  const user = await requireKyc(request)
  const job = await loadJob(jobId)
  if (job.posterId !== user.id) throw Errors.forbidden('Only the poster may cancel this job')
  if (job.status !== 'draft' && job.status !== 'open') throw Errors.conflict('job_locked', 'Only draft or open jobs can be cancelled')
  const [updated] = await getDb().update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(jobs.id, job.id)).returning()
  return jobView(updated!)
}
