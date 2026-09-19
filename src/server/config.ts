/**
 * EscrowLance API — environment configuration (Next.js server runtime).
 *
 * Migrated from the standalone Hono service. Supabase Postgres is the only
 * database driver; Upstash Redis backs the KV/rate-limit/queue layers (with an
 * in-process fallback for zero-infra local dev). The rest of the backend never
 * reads process.env directly — everything is derived here once.
 */
import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: bool(true),
  /** Public origin of the frontend (SIWE domain check + CORS). */
  APP_URI: z.string().url().default('http://localhost:3000'),
  /** Public origin of this API (used to build absolute upload URLs). */
  API_URI: z.string().url().default('http://localhost:3000'),

  // ── Database (Supabase Postgres) ────────────────────────────────────────
  DATABASE_URL: z.string().optional(),
  /** Pool size for the postgres-js client. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // ── Redis (Upstash). Absent → in-process fallback. ─────────────────────
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // ── Supabase (Storage + Realtime + JWT secret). ────────────────────────
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().min(16).default('escrowlance-dev-jwt-secret-do-not-use-in-prod'),

  // ── File storage ────────────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(['supabase', 'local']).optional(), // auto: supabase when configured
  STORAGE_BUCKET: z.string().default('project-files'),
  STORAGE_LOCAL_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // ── Chain ───────────────────────────────────────────────────────────────
  CHAIN_MODE: z.enum(['mock', 'real']).default('mock'),
  CHAIN_ID: z.coerce.number().int().positive().default(84_532), // Base Sepolia
  CHAIN_RPC_URL: z.string().default('https://sepolia.base.org'),
  ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ARBITER_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Display-only mirror of the contract's fee; the contract is the authority. */
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(250),
  ARBITER_FEE_SHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(2000), // 20% of the fee
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(10_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().positive().default(5),
  INDEXER_CHUNK_BLOCKS: z.coerce.number().int().positive().default(2000),

  // ── Auth ────────────────────────────────────────────────────────────────
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(12 * 60 * 60),
  SIWE_NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  SIWE_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(900),

  // ── Roles / disputes ────────────────────────────────────────────────────
  ADMIN_WALLETS: z.string().default(''),
  ARBITER_AGREEMENT_WINDOW_HOURS: z.coerce.number().int().positive().default(48),
  ARBITER_SLA_HOURS: z.coerce.number().int().positive().default(72),

  // ── Webhooks ────────────────────────────────────────────────────────────
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // ── Rate limits (per minute) ───────────────────────────────────────────
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(600),

  // ── Workers ─────────────────────────────────────────────────────────────
  /** Run indexer/crons/webhook delivery inside the request process when Redis is absent. */
  INLINE_WORKERS: bool(true),
})

const parsed = schema.safeParse(process.env)

// In the Next.js server runtime we must not `process.exit` — fall back to the
// schema defaults and surface the problem loudly instead.
if (!parsed.success) {
  console.error('[config] invalid environment, falling back to defaults:', z.treeifyError(parsed.error))
}
const raw = parsed.success ? parsed.data : schema.parse({})

const appUrl = new URL(raw.APP_URI)

const isPostgresUrl = !!raw.DATABASE_URL && /^postgres(ql)?:\/\//.test(raw.DATABASE_URL)
const databaseDriver: 'postgres' | 'unconfigured' = isPostgresUrl ? 'postgres' : 'unconfigured'
const storageDriver = raw.STORAGE_DRIVER ?? (raw.SUPABASE_URL && raw.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'local')
const hasUpstash = !!(raw.UPSTASH_REDIS_REST_URL && raw.UPSTASH_REDIS_REST_TOKEN)
const queueMode: 'redis' | 'inline' = hasUpstash ? 'redis' : 'inline'

let chainMode = raw.CHAIN_MODE
if (chainMode === 'real' && (!raw.ESCROW_ADDRESS || !raw.ARBITER_REGISTRY_ADDRESS)) {
  console.warn('[config] CHAIN_MODE=real requires ESCROW_ADDRESS + ARBITER_REGISTRY_ADDRESS — falling back to mock')
  chainMode = 'mock'
}

if (raw.NODE_ENV === 'production' && raw.SUPABASE_JWT_SECRET.includes('do-not-use-in-prod')) {
  console.error('[config] SUPABASE_JWT_SECRET must be set to a real secret in production')
}

export const env = {
  ...raw,
  chainMode,
  databaseDriver,
  storageDriver,
  queueMode,
  appDomain: appUrl.host,
  adminWallets: raw.ADMIN_WALLETS.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),
} as const

export type Env = typeof env
