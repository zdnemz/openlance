/** /users — profile read/update (PRD F3). Stats are derived, never writable. */
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { requireAuth } from '../auth/middleware'
import { publicUser } from '../auth/service'
import { users, reviews } from '../db/schema'
import { Errors } from '../lib/errors'

export async function updateMe(request: Request) {
  const user = await requireAuth(request)
  const body = await validate(request, z.object({
    displayName: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().max(500).optional(),
    bio: z.string().max(2000).optional(),
    skills: z.array(z.string().min(1).max(40)).max(20).optional(),
    links: z.record(z.string(), z.string().url()).optional(),
    role: z.enum(['client', 'freelancer', 'both']).optional(),
  }))
  const db = getDb()
  const [updated] = await db.update(users).set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, user.id)).returning()
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
