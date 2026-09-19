/**
 * KV abstraction — Upstash Redis when configured, in-process fallback otherwise.
 * Used for: SIWE nonces (single-use, TTL), JWT denylist, rate-limit windows,
 * mock-chain state, and hot caches. The fallback keeps local dev zero-infra.
 */
import { env } from '../config'
import { logger } from './logger'

export interface Kv {
  mode: 'redis' | 'memory'
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  /** Atomic get-and-delete (single-use nonces). */
  getdel(key: string): Promise<string | null>
  del(...keys: string[]): Promise<void>
  /** Increment a fixed-window counter; returns the current count. */
  incrWindow(key: string, windowSeconds: number): Promise<number>
  close(): Promise<void>
}

// ── In-process fallback ────────────────────────────────────────────────────
class MemoryKv implements Kv {
  mode = 'memory' as const
  private map = new Map<string, { v: string; exp?: number }>()
  private windows = new Map<string, { n: number; resetAt: number }>()

  private live(k: string): string | null {
    const e = this.map.get(k)
    if (!e) return null
    if (e.exp && e.exp < Date.now()) {
      this.map.delete(k)
      return null
    }
    return e.v
  }

  async get(k: string) {
    return this.live(k)
  }
  async set(k: string, v: string, ttl?: number) {
    this.map.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : undefined })
    if (this.map.size > 50_000) this.sweep()
  }
  async getdel(k: string) {
    const v = this.live(k)
    this.map.delete(k)
    return v
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.map.delete(k))
  }
  async incrWindow(k: string, windowSeconds: number) {
    const now = Date.now()
    let w = this.windows.get(k)
    if (!w || w.resetAt <= now) {
      w = { n: 0, resetAt: now + windowSeconds * 1000 }
      this.windows.set(k, w)
    }
    return ++w.n
  }
  private sweep() {
    const now = Date.now()
    for (const [k, e] of this.map) if (e.exp && e.exp < now) this.map.delete(k)
  }
  async close() {}
}

// ── Upstash Redis implementation ───────────────────────────────────────────
type UpstashRedis = import('@upstash/redis').Redis

class UpstashKv implements Kv {
  mode = 'redis' as const
  constructor(private readonly redis: UpstashRedis) {}
  async get(k: string) {
    const v = await this.redis.get<string>(k)
    return v ?? null
  }
  async set(k: string, v: string, ttl?: number) {
    if (ttl) await this.redis.set(k, v, { ex: ttl })
    else await this.redis.set(k, v)
  }
  async getdel(k: string) {
    const v = await this.redis.getdel<string>(k)
    return v ?? null
  }
  async del(...keys: string[]) {
    if (keys.length) await this.redis.del(...keys)
  }
  async incrWindow(k: string, windowSeconds: number) {
    const n = await this.redis.incr(k)
    if (n === 1) await this.redis.expire(k, windowSeconds)
    return n
  }
  async close() {}
}

let kvInstance: Kv | undefined

export async function getKv(): Promise<Kv> {
  if (kvInstance) return kvInstance
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import('@upstash/redis')
    const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    kvInstance = new UpstashKv(redis)
    logger.info('KV: upstash redis', { url: env.UPSTASH_REDIS_REST_URL })
  } else {
    kvInstance = new MemoryKv()
    logger.info('KV: in-process memory (no Upstash credentials)')
  }
  return kvInstance
}
