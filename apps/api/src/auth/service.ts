/** /auth domain logic — SIWE nonce + verify + me + logout. */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { Errors } from '../lib/errors.ts'
import { denySession, signSession, verifySession } from '../lib/jwt.ts'
import { requireAuth } from './middleware.ts'
import { issueNonce, verifySiwe } from './siwe.ts'
import { sponsorshipChallenge as getSponsorship, storeSponsorshipSession as storeSponsorship, sponsorshipEnabled, consumeVoucherLoginChallenge, recoverVoucherOwner, voucherSchema } from '../modules/sponsorship.ts'
import { users } from '../db/schema.ts'
import { env } from '../config.ts'

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

const siweLoginSchema = z.object({ message: z.string().min(20), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })

function parseLoginBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw Errors.badRequest('Validation failed')
  return parsed.data
}

export async function verifyLogin(body: unknown) {
  const input = parseLoginBody(siweLoginSchema, body)
  const { address } = await verifySiwe(input.message, input.signature)

  // First sign-in creates the profile — wallet address IS the identity anchor.
  const db = getDb()
  let [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) {
    ;[user] = await db.insert(users).values({ walletAddress: address }).returning()
  }
  const session = await signSession({ sub: user!.id, address })
  return { token: session.token, tokenType: 'Bearer', expiresIn: session.expiresIn, user: publicUser(user!) }
}

/**
 * One-signature login: the EIP-712 sponsorship voucher doubles as the login
 * credential (its signature proves key ownership). Consumes the public login
 * challenge, mints the JWT, and stores the sponsorship session — the client
 * signs once and is immediately gasless.
 */
export async function verifyVoucherLogin(body: unknown) {
  const input = parseLoginBody(voucherSchema, body)
  if (!sponsorshipEnabled()) throw Errors.precondition('sponsorship_disabled', 'Voucher login is not configured on this deployment — use SIWE')
  const { address } = await consumeVoucherLoginChallenge(input)
  const recovered = await recoverVoucherOwner(input, address)
  if (!recovered || recovered.toLowerCase() !== address.toLowerCase()) {
    throw Errors.badRequest('Login voucher signature does not match — request a fresh challenge')
  }
  const db = getDb()
  let [user] = await db.select().from(users).where(eq(users.walletAddress, address)).limit(1)
  if (!user) {
    ;[user] = await db.insert(users).values({ walletAddress: address }).returning()
  }
  const session = await signSession({ sub: user!.id, address })
  const stored = await storeSponsorship(user!.id, address, input)
  return {
    token: session.token, tokenType: 'Bearer', expiresIn: session.expiresIn, user: publicUser(user!),
    sponsorship: { sessionId: stored.sessionId, expiresAt: stored.expiresAt },
  }
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

// ── Gasless sponsorship (bound to the login session) ────────────────────────

/** The EIP-712 challenge the client signs once at login to enable gasless actions. */
export async function getSponsorshipChallenge(request: Request) {
  const user = await requireAuth(request)
  return getSponsorship(user.id, user.walletAddress)
}

/** Persist the signed sponsorship-session voucher returned by the client. */
export async function postSponsorshipSession(request: Request) {
  const user = await requireAuth(request)
  const body = await request.json().catch(() => ({}))
  return storeSponsorship(user.id, user.walletAddress, body)
}
