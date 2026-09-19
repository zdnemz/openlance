/**
 * Session tokens are Supabase-compatible HS256 JWTs:
 *   { sub: <user uuid>, address, role: 'authenticated', aud: 'authenticated' }
 *
 * One token therefore authenticates against BOTH this API (Bearer header)
 * and Supabase Realtime/Storage (which validate the project JWT secret).
 * SIWE proves wallet ownership; the DB user row is the identity source.
 */
import { SignJWT, jwtVerify } from 'jose'
import { env } from '../config'

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET)

export interface SessionClaims {
  sub: string // user uuid
  address: string // wallet (lowercase)
  jti: string
  exp: number
  iat: number
}

export async function signSession(input: { sub: string; address: string }): Promise<{ token: string; jti: string; expiresIn: number }> {
  const jti = crypto.randomUUID()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + env.SESSION_TTL_SECONDS
  const token = await new SignJWT({ address: input.address, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.sub)
    .setJti(jti)
    .setAudience('authenticated')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secret)
  return { token, jti, expiresIn: env.SESSION_TTL_SECONDS }
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { audience: 'authenticated', algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string' || typeof payload.address !== 'string' || typeof payload.jti !== 'string') return null
    return { sub: payload.sub, address: payload.address, jti: payload.jti, exp: payload.exp ?? 0, iat: payload.iat ?? 0 }
  } catch {
    return null
  }
}

// ── Denylist (logout / revocation), stored in the KV layer ─────────────────
const denyKey = (jti: string) => `jwt:deny:${jti}`

export async function denySession(jti: string, ttlSeconds = env.SESSION_TTL_SECONDS) {
  const { getKv } = await import('./kv')
  await (await getKv()).set(denyKey(jti), '1', ttlSeconds)
}

export async function isSessionDenied(jti: string): Promise<boolean> {
  const { getKv } = await import('./kv')
  return (await (await getKv()).get(denyKey(jti))) !== null
}
