/**
 * Read-through cache over the KV layer (Upstash Redis).
 *
 * Hot, mostly-static reads (overview counts, arbiter registry, public job
 * lists) are cached for a short TTL. The mirror is an untrusted cache anyway;
 * this only adds a little latency headroom. Cache misses and KV errors fall
 * through to the source — a cache must never be a correctness dependency.
 */
import { getKv } from './kv'
import { logger } from './logger'

export interface CacheOptions {
  ttlSeconds: number
  /** Prefix namespace so keys are easy to reason about / flush. */
  namespace?: string
}

export async function cached<T>(key: string, opts: CacheOptions, load: () => Promise<T>): Promise<T> {
  const ns = opts.namespace ?? 'cache'
  const fullKey = `${ns}:${key}`
  try {
    const kv = await getKv()
    const hit = await kv.get(fullKey)
    if (hit !== null) return JSON.parse(hit) as T
    const value = await load()
    await kv.set(fullKey, JSON.stringify(value), opts.ttlSeconds)
    return value
  } catch (err) {
    logger.warn('cache bypassed', { key: fullKey, err: String(err) })
    return load()
  }
}

/** Invalidate keys by exact name within a namespace (best-effort). */
export async function invalidate(...fullKeys: string[]): Promise<void> {
  try {
    const kv = await getKv()
    await kv.del(...fullKeys)
  } catch (err) {
    logger.warn('cache invalidation failed', { err: String(err) })
  }
}
