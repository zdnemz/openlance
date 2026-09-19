/** /arbiters — read model over the on-chain ArbiterRegistry mirror (PRD F11/F12). */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { cached } from '../lib/cache'
import { arbiters, users } from '../db/schema'
import { Errors } from '../lib/errors'

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

export async function listArbiters() {
  return cached('arbiters:list', { ttlSeconds: 20, namespace: 'read' }, async () => {
    const db = getDb()
    const rows = await db.select().from(arbiters).orderBy(desc(arbiters.trustScore))
    return Promise.all(rows.map(async (a) => {
      const [u] = await db.select().from(users).where(eq(users.walletAddress, a.address)).limit(1)
      return view(a, u)
    }))
  })
}

export async function getArbiter(address: string) {
  const addr = address.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw Errors.badRequest('Invalid wallet address')
  const db = getDb()
  const [a] = await db.select().from(arbiters).where(eq(arbiters.address, addr)).limit(1)
  if (!a) throw Errors.notFound('Arbiter')
  const [u] = await db.select().from(users).where(eq(users.walletAddress, addr)).limit(1)
  return view(a, u)
}
