import Redis from 'ioredis'

declare global {
  // eslint-disable-next-line no-var
  var redisClient: Redis | undefined
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export function getRedisClient(): Redis {
  if (globalThis.redisClient) {
    return globalThis.redisClient
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        return null
      }
      return Math.min(times * 200, 2000)
    },
  })

  client.on('error', (err) => {
    console.error('Redis connection error:', err)
  })

  client.on('connect', () => {
    console.warn('Redis connected successfully')
  })

  if (process.env.NODE_ENV !== 'production') {
    globalThis.redisClient = client
  }

  return client
}

export const redis = getRedisClient()

// Cache utilities
export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redis.get(key)
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return value as unknown as T
  }
}

export async function setCache(
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<'OK' | null> {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (ttlSeconds) {
    return redis.setex(key, ttlSeconds, serialized)
  }
  return redis.set(key, serialized)
}

export async function deleteCache(key: string): Promise<number> {
  return redis.del(key)
}

export async function deleteCachePattern(pattern: string): Promise<number> {
  const keys = await redis.keys(pattern)
  if (keys.length === 0) return 0
  return redis.del(...keys)
}

export async function getCacheOrSet<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds?: number
): Promise<T> {
  const cached = await getCache<T>(key)
  if (cached !== null) {
    return cached
  }

  const value = await fetcher()
  await setCache(key, value, ttlSeconds)
  return value
}

export { Redis }
export default redis
