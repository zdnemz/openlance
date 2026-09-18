/** /users — profile read/update (PRD F3). Stats are derived, never writable. */
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { readLimiter, writeLimiter } from '../lib/rate-limit'
import { requireAuth, getUser } from '../auth/middleware'
import { publicUser } from '../auth/routes'
import { users, reviews } from '../db/schema'
import { Errors } from '../lib/errors'

export const userRoutes = new Hono()

userRoutes.patch('/me', writeLimiter(), requireAuth, async (c) => {
  const body = await validate(c, z.object({
    displayName: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().max(500).optional(),
    bio: z.string().max(2000).optional(),
    skills: z.array(z.string().min(1).max(40)).max(20).optional(),
    links: z.record(z.string(), z.string().url()).optional(),
    role: z.enum(['client', 'freelancer', 'both']).optional(),
  }))
  const db = await getDb()
  const [updated] = await db.update(users).set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, getUser(c).id)).returning()
  return ok(c, publicUser(updated!))
})

userRoutes.get('/:address', readLimiter(), async (c) => {
  const address = c.req.param('address').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw Errors.badRequest('Invalid wallet address')
  const db = await getDb()
  const [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) throw Errors.notFound('User')
  return ok(c, publicUser(user))
})

userRoutes.get('/:address/reviews', readLimiter(), async (c) => {
  const address = c.req.param('address').toLowerCase()
  const db = await getDb()
  const [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) throw Errors.notFound('User')
  const rows = await db.select().from(reviews)
    .where(eq(reviews.revieweeId, user.id))
    .orderBy(desc(reviews.createdAt)).limit(100)
  return ok(c, rows)
})
