/** /auth — SIWE nonce + verify + me + logout. */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { ok, validate } from '../lib/http'
import { authLimiter } from '../lib/rate-limit'
import { denySession, signSession } from '../lib/jwt'
import { issueNonce, verifySiwe } from './siwe'
import { requireAuth, getUser } from './middleware'
import { users } from '../db/schema'
import { env } from '../config'

export const authRoutes = new Hono()

/** Public wallet-style profile projection. */
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
    isArbiter: u.isArbiter,
    stats: {
      totalEarnedWei: u.totalEarnedWei,
      totalPaidWei: u.totalPaidWei,
      completedProjectsAsClient: u.completedProjectsAsClient,
      completedProjectsAsFreelancer: u.completedProjectsAsFreelancer,
    },
    createdAt: u.createdAt,
  }
}

authRoutes.get('/nonce', authLimiter(), async (c) => {
  const { nonce, expiresInSeconds } = await issueNonce()
  return ok(c, {
    nonce,
    expiresInSeconds,
    /** Frontend hints for building the EIP-4361 message. */
    siwe: { domain: env.appDomain, chainId: env.CHAIN_ID, statement: 'Sign in to EscrowLance - milestone escrow for freelance work.' },
  })
})

authRoutes.post('/verify', authLimiter(), async (c) => {
  const body = await validate(c, z.object({ message: z.string().min(20), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }))
  const { address } = await verifySiwe(body.message, body.signature)

  // First sign-in creates the profile — wallet address IS the identity anchor.
  const db = await getDb()
  let [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) {
    ;[user] = await db.insert(users).values({ walletAddress: address }).returning()
  }
  const session = await signSession({ sub: user.id, address })
  return ok(c, { token: session.token, tokenType: 'Bearer', expiresIn: session.expiresIn, user: publicUser(user) })
})

authRoutes.get('/me', requireAuth, async (c) => {
  return ok(c, publicUser(getUser(c)))
})

authRoutes.post('/logout', requireAuth, async (c) => {
  const header = c.req.header('authorization')!
  const claims = await (await import('../lib/jwt')).verifySession(header.slice(7))
  if (claims) await denySession(claims.jti)
  return ok(c, { loggedOut: true })
})
