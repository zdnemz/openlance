/** /users — profile read/update (PRD F3). Stats are derived, never writable. */
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth, requireKyc } from '../auth/middleware'
import { publicUser } from '../auth/service'
import { users, reviews } from '../db/schema'
import { Errors } from '../lib/errors'

export async function updateMe(request: Request) {
  const user = await requireKyc(request)
  const body = await validate(request, z.object({
    displayName: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().max(500).optional(),
    bio: z.string().max(2000).optional(),
    skills: z.array(z.string().min(1).max(40)).max(20).optional(),
    links: z.record(z.string(), z.string().url()).optional(),
  }))
  const db = getDb()
  const [updated] = await db.update(users).set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
  return publicUser(updated!)
}

/**
 * Set the initial role (client / freelancer / arbiter) during onboarding.
 * One-way: once KYC has started (pending) or completed (verified) the role
 * is locked — there is no change-role feature. The proxy additionally
 * refuses re-entry to /onboarding once verified.
 */
export async function switchRole(request: Request) {
  const user = await requireAuth(request)
  if (user.kycStatus !== 'none') {
    throw Errors.forbidden('Role is locked after onboarding started — contact support to change seats')
  }
  const body = await validate(request, z.object({ role: z.enum(['client', 'freelancer', 'arbiter']) }))
  const db = getDb()
  const [updated] = await db.update(users)
    .set({ role: body.role, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
  return publicUser(updated!)
}

const KYC_LEVELS = { client: 'light', freelancer: 'standard', arbiter: 'enhanced' } as const

/**
 * Simulated KYC submission — per-role depth, no real provider.
 *  · client:     name + country → auto-verified instantly.
 *  · freelancer: + idType + idNumber → pending (demo auto-approves on next read).
 *  · arbiter:    + idNumber + liveness checkbox → pending, needs enhanced review.
 */
export async function submitKyc(request: Request) {
  const user = await requireAuth(request)
  const body = await validate(request, z.object({
    fullName: z.string().min(2).max(120),
    country: z.string().min(2).max(80),
    idType: z.enum(['passport', 'drivers_license', 'national_id']).optional(),
    idNumber: z.string().min(4).max(40).optional(),
    livenessConfirmed: z.boolean().optional(),
  }).strict())
  if (user.role === 'freelancer' && !body.idType) throw Errors.badRequest('Freelancer KYC needs an ID type')
  if (user.role === 'arbiter') {
    if (!body.idType || !body.idNumber || !body.livenessConfirmed) {
      throw Errors.badRequest('Arbiter KYC needs ID type + number + liveness confirmation')
    }
  }
  const instant = user.role === 'client'
  const db = getDb()
  const [updated] = await db.update(users).set({
    kycStatus: instant ? 'verified' : 'pending',
    kycLevel: KYC_LEVELS[user.role as keyof typeof KYC_LEVELS] ?? 'light',
    kycUpdatedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(users.id, user.id)).returning()
  return { user: publicUser(updated!), simulated: true, autoVerified: instant }
}

/** Demo reviewer: approve the caller's own pending KYC (simulates the ops queue). */
export async function approveOwnKyc(request: Request) {
  const user = await requireAuth(request)
  if (user.kycStatus !== 'pending') throw Errors.conflict('kyc_not_pending', `KYC is ${user.kycStatus}`)
  const db = getDb()
  const [updated] = await db.update(users).set({
    kycStatus: 'verified', kycUpdatedAt: new Date(), updatedAt: new Date(),
  }).where(eq(users.id, user.id)).returning()
  return publicUser(updated!)
}

export async function getUserByAddress(address: string) {
  const addr = address.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw Errors.badRequest('Invalid wallet address')
  const db = getDb()
  const [user] = await db.select().from(users).where(eq(users.walletAddress, addr)).limit(1)
  if (!user) throw Errors.notFound('User')
  return publicUser(user)
}

export async function getUserReviews(address: string) {
  const addr = address.toLowerCase()
  const db = getDb()
  const [user] = await db.select().from(users).where(eq(users.walletAddress, addr)).limit(1)
  if (!user) throw Errors.notFound('User')
  return db.select().from(reviews)
    .where(eq(reviews.revieweeId, user.id))
    .orderBy(desc(reviews.createdAt)).limit(100)
}
