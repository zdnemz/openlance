/**
 * Fixed-window rate limiting via the KV layer (Redis INCR+EXPIRE in real mode).
 * Fails OPEN on KV errors — availability over strictness for a portfolio app.
 */
import type { MiddlewareHandler } from 'hono'
import { env } from '../config'
import { Errors } from './errors'
import { getKv } from './kv'

export function rateLimit(opts: { perMinute: number; keyBy?: 'ip' | 'user'; bucket: string }): MiddlewareHandler {
  return async (c, next) => {
    try {
      const kv = await getKv()
      const who = opts.keyBy === 'user'
        ? (c.get('userId') as string | undefined) ?? c.req.header('x-forwarded-for') ?? 'anon'
        : c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
      const n = await kv.incrWindow(`rl:${opts.bucket}:${who}`, 60)
      c.header('X-RateLimit-Limit', String(opts.perMinute))
      c.header('X-RateLimit-Remaining', String(Math.max(0, opts.perMinute - n)))
      if (n > opts.perMinute) throw Errors.tooMany(`Rate limit exceeded (${opts.perMinute}/min) — retry shortly`)
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 429) throw err
      // KV unavailable → fail open
      c.header('X-RateLimit-Mode', 'fail-open')
    }
    await next()
  }
}

export const authLimiter = () => rateLimit({ perMinute: env.RATE_LIMIT_AUTH_PER_MIN, keyBy: 'ip', bucket: 'auth' })
export const writeLimiter = () => rateLimit({ perMinute: env.RATE_LIMIT_WRITE_PER_MIN, keyBy: 'user', bucket: 'write' })
export const readLimiter = () => rateLimit({ perMinute: env.RATE_LIMIT_READ_PER_MIN, keyBy: 'user', bucket: 'read' })
