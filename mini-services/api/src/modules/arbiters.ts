/** /arbiters — read model over the on-chain ArbiterRegistry mirror (PRD F11/F12). */
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { ok } from '../lib/http'
import { readLimiter } from '../lib/rate-limit'
import { arbiters, users } from '../db/schema'
import { Errors } from '../lib/errors'

export const arbiterRoutes = new Hono()

function view(a: typeof arbiters.$inferSelect, profile?: typeof users.$inferSelect) {
  return {
    address: a.address,
    registered: a.registered,
    sbtTokenId: a.sbtTokenId,
    trustScore: a.trustScore,
    resolutions: a.resolutions,
    resolutionsWithinSla: a.resolutionsWithinSla,
    resolutionsLate: a.resolutionsLate,
    registeredAt: a.registeredAt,
    profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl } : null,
    /** ERC-5194: the trust token is soulbound — transfers revert by design. */
    soulbound: true,
  }
}

arbiterRoutes.get('/', readLimiter(), async (c) => {
  const db = await getDb()
  const rows = await db.select().from(arbiters).orderBy(desc(arbiters.trustScore))
  const withProfiles = await Promise.all(rows.map(async (a) => {
    const [u] = await db.select().from(users).where(eq(users.walletAddress, a.address)).limit(1)
    return view(a, u)
  }))
  return ok(c, withProfiles)
})

arbiterRoutes.get('/:address', readLimiter(), async (c) => {
  const address = c.req.param('address').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw Errors.badRequest('Invalid wallet address')
  const db = await getDb()
  const [a] = await db.select().from(arbiters).where(eq(arbiters.address, address)).limit(1)
  if (!a) throw Errors.notFound('Arbiter')
  const [u] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  return ok(c, view(a, u))
})
