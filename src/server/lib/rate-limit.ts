/**
 * Fixed-window rate limiting via the KV layer (Upstash Redis INCR+EXPIRE).
 * Fails OPEN on KV errors — availability over strictness for a portfolio app.
 *
 * Adapter for Next.js route handlers: instead of Hono middleware it returns a
 * `checkRateLimit` helper called at the top of a handler. It reads the client
 * identity from the forwarded-for header (ip) or the authenticated user id.
 */
import { env } from '../config'
import { Errors } from './errors'
import { getKv } from './kv'

export type RateLimitOptions = { perMinute: number; keyBy?: 'ip' | 'user'; bucket: string }

export interface RateLimitResult {
  limit: number
  remaining: number
  mode?: 'fail-open'
}

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}

export async function checkRateLimit(
  request: Request,
  opts: RateLimitOptions,
  userId?: string,
): Promise<RateLimitResult> {
  try {
    const kv = await getKv()
    const who = opts.keyBy === 'user' ? userId ?? clientIp(request) : clientIp(request)
    const n = await kv.incrWindow(`rl:${opts.bucket}:${who}`, 60)
    if (n > opts.perMinute) throw Errors.tooMany(`Rate limit exceeded (${opts.perMinute}/min) — retry shortly`)
    return { limit: opts.perMinute, remaining: Math.max(0, opts.perMinute - n) }
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 429) throw err
    // KV unavailable → fail open
    return { limit: opts.perMinute, remaining: opts.perMinute, mode: 'fail-open' }
  }
}

export const authRateLimit = (request: Request) => checkRateLimit(request, { perMinute: env.RATE_LIMIT_AUTH_PER_MIN, keyBy: 'ip', bucket: 'auth' })
export const writeRateLimit = (request: Request, userId?: string) => checkRateLimit(request, { perMinute: env.RATE_LIMIT_WRITE_PER_MIN, keyBy: 'user', bucket: 'write' }, userId)
export const readRateLimit = (request: Request, userId?: string) => checkRateLimit(request, { perMinute: env.RATE_LIMIT_READ_PER_MIN, keyBy: 'user', bucket: 'read' }, userId)
