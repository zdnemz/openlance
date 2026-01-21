// Redis Key Patterns and TTL Constants

export const REDIS_KEYS = {
  // Session Management
  SESSION: (sessionId: string) => `session:${sessionId}`,
  USER_SESSIONS: (userId: string) => `session:user:${userId}:sessions`,
  REFRESH_TOKEN: (tokenHash: string) => `refresh_token:${tokenHash}`,

  // Rate Limiting
  RATE_LIMIT: (ip: string, endpoint: string) => `rate_limit:${ip}:${endpoint}`,
  RATE_LIMIT_USER: (userId: string, action: string) => `rate_limit:user:${userId}:${action}`,
  ABUSE_IP: (ip: string) => `abuse:ip:${ip}`,

  // Caching
  CACHE_USER_PROFILE: (userId: string) => `cache:user:${userId}:profile`,
  CACHE_PROJECT: (projectId: string) => `cache:project:${projectId}`,
  CACHE_PROJECT_LIST: (hash: string) => `cache:project:list:${hash}`,
  CACHE_SKILLS_ALL: 'cache:skills:all',
  CACHE_CATEGORIES_ALL: 'cache:categories:all',

  // Real-time Presence
  PRESENCE_USER: (userId: string) => `presence:user:${userId}`,
  PRESENCE_TYPING: (conversationId: string) => `presence:typing:${conversationId}`,

  // Distributed Locks
  LOCK_PAYOUT: (userId: string) => `lock:payout:${userId}`,
  LOCK_ESCROW: (escrowId: string) => `lock:escrow:${escrowId}`,

  // Pub/Sub Channels
  CHANNEL_NOTIFICATIONS: (userId: string) => `channel:notifications:${userId}`,
  CHANNEL_CHAT: (conversationId: string) => `channel:chat:${conversationId}`,
  CHANNEL_PRESENCE: 'channel:presence',
} as const

export const REDIS_TTL = {
  SESSION: 24 * 60 * 60, // 24 hours
  REFRESH_TOKEN: 7 * 24 * 60 * 60, // 7 days
  RATE_LIMIT_WINDOW: 60, // 60 seconds
  ABUSE_BLOCK: 60 * 60, // 1 hour
  CACHE_USER_PROFILE: 5 * 60, // 5 minutes
  CACHE_PROJECT: 2 * 60, // 2 minutes
  CACHE_PROJECT_LIST: 60, // 1 minute
  CACHE_STATIC_DATA: 60 * 60, // 1 hour
  PRESENCE_HEARTBEAT: 5 * 60, // 5 minutes
  PRESENCE_TYPING: 5, // 5 seconds
  LOCK_DEFAULT: 30, // 30 seconds
} as const
