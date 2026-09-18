/**
 * EscrowLance API — environment configuration.
 *
 * Design goal: `bun run dev` works with ZERO configuration (embedded Postgres
 * via PGlite, in-process queue/cache, mock chain, local-disk storage), while a
 * Supabase + Redis + Base Sepolia deployment is one .env away. Every adapter
 * choice is derived here so the rest of the codebase never reads process.env.
 */
import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3030),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: bool(true),
  /** Public origin of the frontend (SIWE domain check + CORS). */
  APP_URI: z.string().url().default('http://localhost:3000'),
  /** Public origin of this API (used to build local upload URLs). */
  API_URI: z.string().url().default('http://localhost:3030'),

  // ── Database ────────────────────────────────────────────────────────────
  /** 'postgres' (Supabase/any PG) when DATABASE_URL is set, else embedded PGlite. */
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).optional(),
  DATABASE_URL: z.string().optional(),
  PGLITE_DATA_DIR: z.string().default('./data/pglite'),

  // ── Redis (cache + queues). Absent → in-process fallback. ──────────────
  REDIS_URL: z.string().optional(),

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
  /** Run indexer/crons/webhook delivery inside the API process when Redis is absent. */
  INLINE_WORKERS: bool(true),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', z.treeifyError(parsed.error))
  process.exit(1)
}
const raw = parsed.data

// ── Derived configuration ──────────────────────────────────────────────────
const appUrl = new URL(raw.APP_URI)

// Only honor DATABASE_URL when it is actually a Postgres connection string —
// dev machines (and this monorepo's root) often export a Prisma SQLite
// `file:...` DATABASE_URL that must NOT switch us to the postgres driver.
const isPostgresUrl = !!raw.DATABASE_URL && /^postgres(ql)?:\/\//.test(raw.DATABASE_URL)
const databaseDriver = raw.DATABASE_DRIVER ?? (isPostgresUrl ? 'postgres' : 'pglite')
const storageDriver = raw.STORAGE_DRIVER ?? (raw.SUPABASE_URL && raw.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'local')
const queueMode: 'redis' | 'inline' = raw.REDIS_URL ? 'redis' : 'inline'

let chainMode = raw.CHAIN_MODE
if (chainMode === 'real' && (!raw.ESCROW_ADDRESS || !raw.ARBITER_REGISTRY_ADDRESS)) {
  console.warn('[config] CHAIN_MODE=real requires ESCROW_ADDRESS + ARBITER_REGISTRY_ADDRESS — falling back to mock')
  chainMode = 'mock'
}

if (raw.NODE_ENV === 'production' && raw.SUPABASE_JWT_SECRET.includes('do-not-use-in-prod')) {
  console.error('[config] SUPABASE_JWT_SECRET must be set to a real secret in production')
  process.exit(1)
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
