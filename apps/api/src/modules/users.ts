/** /users — profile read/update (PRD F3). Stats are derived, never writable. */
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { validate } from '../lib/http.ts'
import { requireAuth, requireKyc } from '../auth/middleware.ts'
import { readSeat, verifySeatClaim } from '../chain/role-registry.ts'
import { users, reviews, type User } from '../db/schema.ts'
import { env } from '../config.ts'
import { Errors } from '../lib/errors.ts'

/**
 * Public wallet-style profile projection. Lives here, next to the row it
 * projects, because both login paths need it AND the seat sync below: keeping
 * it in auth/service.ts would make this module import auth/service.ts while
 * auth/service.ts imports this one.
 */
export function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    walletAddress: u.walletAddress,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    skills: u.skills,
    links: u.links,
    role: u.role,
    kycStatus: u.kycStatus,
    kycLevel: u.kycLevel,
    isAdmin: env.adminWallets.includes(u.walletAddress),
    stats: {
      totalEarnedWei: u.totalEarnedWei,
      totalPaidWei: u.totalPaidWei,
      completedProjectsAsClient: u.completedProjectsAsClient,
      completedProjectsAsFreelancer: u.completedProjectsAsFreelancer,
    },
    createdAt: u.createdAt,
  }
}

/**
 * The wallet's row by address — created on first sign-in — with its seat
 * re-read from the chain. Every sign-in goes through here, so a wallet that
 * already claimed a seat gets it back after the database is reset instead of
 * being offered the column default as a fresh choice.
 */
export async function loadUserByAddress(address: string): Promise<User> {
  const db = getDb()
  let [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) {
    ;[user] = await db.insert(users).values({ walletAddress: address }).returning()
  }
  return syncRoleFromChain(user!)
}

/**
 * A blank or null value CLEARS the column. Every other profile field has to
 * accept this: without it there is no way to unset a name or a bio once set.
 * `min(1)` rejected "" outright, and the form's `|| undefined` omitted the key
 * entirely — which means "leave unchanged". Both spellings of "clear" were
 * no-ops, so a value could never be removed.
 */
export const clearable = (max: number) =>
  z.string().max(max).nullable().transform((v) => {
    const s = v?.trim()
    return s ? s : null
  })

export async function updateMe(request: Request) {
  const user = await requireKyc(request)
  const body = await validate(request, z.object({
    displayName: clearable(80).optional(),
    avatarUrl: z.string().url().max(500).optional(),
    bio: clearable(2000).optional(),
    skills: z.array(z.string().min(1).max(40)).max(20).optional(),
    links: z.record(z.string(), z.string().url()).optional(),
  }))
  const db = getDb()
  const [updated] = await db.update(users).set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
  return publicUser(updated!)
}

/**
 * Confirm the seat during onboarding. This is a MIRROR write, not a claim: the
 * wallet has already claimed (or paid to switch) on-chain, and this only
 * mirrors what the chain holds into `users.role`.
 *
 * Two locks, both of which used to be one DB check that a wiped row reset:
 *   · the chain — the seat is whatever RoleRegistry says, and a mismatch is a
 *     409 rather than a silent overwrite (`verifySeatClaim`);
 *   · KYC — once verification has started the column is frozen.
 * A later change is a paid `RoleRegistry.switchRole` transaction; there is no
 * API route that moves a seat for free.
 */
export async function confirmRole(request: Request) {
  const user = await requireAuth(request)
  if (user.kycStatus !== 'none') {
    throw Errors.forbidden('Role is locked after onboarding started — contact support to change seats')
  }
  const body = await validate(request, z.object({ role: z.enum(['client', 'freelancer', 'arbiter']) }))
  verifySeatClaim(await readSeat(user.walletAddress), body.role)
  const db = getDb()
  const [updated] = await db.update(users)
    .set({ role: body.role, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
  return publicUser(updated!)
}

/**
 * Re-seat a wallet from the chain on sign-in. This is what makes a wiped
 * database survivable: the row comes back as the column default (`client`),
 * and without this read the wallet would re-onboard and be offered a free
 * choice of a seat it already owns.
 *
 * Only ever moves the column TOWARD the chain, and only when the chain has
 * answered — an unreadable registry leaves the row alone rather than guessing.
 */
export async function syncRoleFromChain(user: User) {
  const read = await readSeat(user.walletAddress)
  if (read.state !== 'claimed' || read.role === user.role) return user
  const db = getDb()
  const [updated] = await db.update(users)
    .set({ role: read.role, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
  return updated ?? user
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
