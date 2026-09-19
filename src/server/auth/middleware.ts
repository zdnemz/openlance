/**
 * Auth context for Next.js route handlers.
 *
 * Hono's middleware model (c.set/c.get) doesn't map to App Router handlers, so
 * authentication is exposed as explicit async helpers the handler calls:
 *   - `optionalAuth(request)`  → user | undefined (for routes that behave
 *     differently when signed in)
 *   - `requireAuth(request)`   → user (throws 401)
 *   - `requireAdmin(request)`  → user (throws 401/403)
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { Errors } from '../lib/errors'
import { isSessionDenied, verifySession } from '../lib/jwt'
import { env } from '../config'
import { users, type User } from '../db/schema'

export async function optionalAuth(request: Request): Promise<User | undefined> {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return undefined
  const claims = await verifySession(header.slice(7))
  if (!claims || (await isSessionDenied(claims.jti))) return undefined
  const db = getDb()
  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1)
  return user
}

export async function requireAuth(request: Request): Promise<User> {
  const user = await optionalAuth(request)
  if (!user) throw Errors.unauthorized()
  return user
}

export async function requireAdmin(request: Request): Promise<User> {
  const user = await requireAuth(request)
  if (!env.adminWallets.includes(user.walletAddress)) {
    throw Errors.forbidden('Admin wallet required')
  }
  return user
}
