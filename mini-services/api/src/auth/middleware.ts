/** Auth context middleware — Bearer JWT → user row on `c.set('user')`. */
import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { Errors } from '../lib/errors'
import { isSessionDenied, verifySession } from '../lib/jwt'
import { env } from '../config'
import { users, type User } from '../db/schema'

export interface AuthVars {
  user: User
}

/** Populate c.get('user') when a valid token is present; anonymous otherwise. */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) {
    const claims = await verifySession(header.slice(7))
    if (claims && !(await isSessionDenied(claims.jti))) {
      const [user] = await (await getDb()).select().from(users).where(eq(users.id, claims.sub)).limit(1)
      if (user) c.set('user', user)
    }
  }
  await next()
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get('user')) throw Errors.unauthorized()
  await next()
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get('user')
  if (!user) throw Errors.unauthorized()
  if (!env.adminWallets.includes(user.walletAddress)) {
    throw Errors.forbidden('Admin wallet required')
  }
  await next()
}

export function getUser(c: { get: (k: 'user') => unknown }): User {
  const u = c.get('user') as User | undefined
  if (!u) throw Errors.unauthorized()
  return u
}
