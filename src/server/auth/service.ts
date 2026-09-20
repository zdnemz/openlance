/** /auth domain logic — SIWE nonce + verify + me + logout. */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { validate } from '../lib/http'
import { denySession, signSession, verifySession } from '../lib/jwt'
import { requireAuth } from './middleware'
import { issueNonce, verifySiwe } from './siwe'
import { users } from '../db/schema'
import { env } from '../config'

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
    kycStatus: u.kycStatus,
    kycLevel: u.kycLevel,
    arbiterTier: u.arbiterTier,
    isArbiter: u.isArbiter,
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

export async function getNonce() {
  const { nonce, expiresInSeconds } = await issueNonce()
  return {
    nonce,
    expiresInSeconds,
    /** Frontend hints for building the EIP-4361 message. */
    siwe: {
      domain: env.appDomain,
      chainId: env.CHAIN_ID,
      statement: 'Sign in to OpenLance - milestone escrow for freelance work.',
    },
  }
}

export async function verifyLogin(request: Request) {
  const body = await validate(request, z.object({ message: z.string().min(20), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }))
  const { address } = await verifySiwe(body.message, body.signature)

  // First sign-in creates the profile — wallet address IS the identity anchor.
  const db = getDb()
  let [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) {
    ;[user] = await db.insert(users).values({ walletAddress: address }).returning()
  }
  const session = await signSession({ sub: user!.id, address })
  return { token: session.token, tokenType: 'Bearer', expiresIn: session.expiresIn, user: publicUser(user!) }
}

export async function me(request: Request) {
  return publicUser(await requireAuth(request))
}

export async function logout(request: Request) {
  const header = request.headers.get('authorization')
  if (header?.startsWith('Bearer ')) {
    const claims = await verifySession(header.slice(7))
    if (claims) await denySession(claims.jti)
  }
  return { loggedOut: true }
}
