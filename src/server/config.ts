/**
 * OpenLance API — environment configuration (Next.js server runtime).
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
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().min(16).default('openlance-dev-jwt-secret-do-not-use-in-prod'),
  /** Project ref (subdomain of SUPABASE_URL) — inferred when omitted. */
  SUPABASE_PROJECT_REF: z.string().optional(),

  // ── File storage ────────────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(['supabase', 'local']).optional(), // auto: supabase when configured
  STORAGE_BUCKET: z.string().default('project-files'),
  /** 'private' → signed URLs only; 'public' → unauth reads via public URL. */
  STORAGE_BUCKET_VISIBILITY: z.enum(['private', 'public']).default('private'),
  /** Object-key prefix applied to every upload (e.g. an env/tenant namespace). */
  STORAGE_PREFIX: z.string().default(''),
  /** Comma-separated MIME allowlist; empty → built-in default list. */
  STORAGE_ALLOWED_MIME: z.string().default(''),
  STORAGE_LOCAL_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // ── Chain ───────────────────────────────────────────────────────────────
  CHAIN_MODE: z.enum(['mock', 'real']).default('mock'),
  CHAIN_ID: z.coerce.number().int().positive().default(84_532), // Base Sepolia
  CHAIN_RPC_URL: z.string().default('https://sepolia.base.org'),
  ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ARBITER_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** TimelockController that owns the UUPS proxies (informational). */
  TIMELOCK_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Display-only mirror of the contract's fee; the contract is the authority. */
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(250),
  /**
   * Display-only mirror of the escrow's dispute fee (wei). The contract reads
   * are authoritative; this is used for UI copy before the first RPC read.
   */
  DISPUTE_FEE_WEI: z.string().regex(/^\d+$/).default('50000000000000000'), // 0.05 ETH
  /** Minimum arbiter stake (wei) shown in the staking UI. */
  MIN_STAKE_WEI: z.string().regex(/^\d+$/).default('100000000000000000'), // 0.1 ETH
  /** Minimum trust score n below which a stake locks (mirrors the registry). */
  MIN_SCORE_TO_WITHDRAW: z.coerce.number().int().min(0).max(100).default(50),
  /**
   * Display-only mirrors of the registry's time-based staking rules (seconds).
   * The contract reads are authoritative; these seed the UI copy before the
   * first RPC read and back the /overview config.
   */
  MIN_STAKE_DURATION_SECONDS: z.coerce.number().int().nonnegative().default(7 * 24 * 60 * 60), // 7 days
  UNSTAKE_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(3 * 24 * 60 * 60), // 3 days
  ARBITER_FEE_SHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(2000), // 20% of the fee
  /**
   * Display-only mirrors of the escrow's dispute windows (seconds).
   * The contract reads are authoritative for signing; these seed the UI copy
   * and let the indexer stamp commit/reveal deadlines (events carry no timestamps).
   * Match contracts/scripts/deploy.ts: local 120/120/600, prod 86400/86400/172800.
   */
  COMMIT_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(86400),
  REVEAL_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(86400),
  APPEAL_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(172800),
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
  /**
   * Shared secret for the inbound event endpoint (POST /api/internal/inbound).
   * Unset → the endpoint is disabled (404). Senders sign the raw body with
   * HMAC-SHA256 and pass it as `X-OpenLance-Signature: sha256=<hex>`.
   */
  INBOUND_WEBHOOK_SECRET: z.string().min(16).optional(),

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
const hasSupabaseStorage = !!(raw.SUPABASE_URL && raw.SUPABASE_SERVICE_ROLE_KEY)
const storageDriver = raw.STORAGE_DRIVER ?? (hasSupabaseStorage ? 'supabase' : 'local')
const hasUpstash = !!(raw.UPSTASH_REDIS_REST_URL && raw.UPSTASH_REDIS_REST_TOKEN)
const queueMode: 'redis' | 'inline' = hasUpstash ? 'redis' : 'inline'

// Supabase project ref: explicit env wins, else inferred from the URL host
// (https://<ref>.supabase.co). Used for host allowlisting + logs.
const projectRef = raw.SUPABASE_PROJECT_REF
  ?? (raw.SUPABASE_URL ? new URL(raw.SUPABASE_URL).hostname.split('.')[0] ?? null : null)

// Fail fast in production if supabase was explicitly requested but unconfigured.
if (raw.NODE_ENV === 'production' && raw.STORAGE_DRIVER === 'supabase' && !hasSupabaseStorage) {
  console.error('[config] STORAGE_DRIVER=supabase requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY')
}

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
  /**
   * Resolved storage system config — one place every consumer reads from.
   * `configured` reflects whether the selected driver has real credentials.
   */
  storage: {
    driver: storageDriver,
    configured: storageDriver === 'supabase' ? hasSupabaseStorage : true,
    bucket: raw.STORAGE_BUCKET,
    visibility: raw.STORAGE_BUCKET_VISIBILITY,
    prefix: raw.STORAGE_PREFIX.replace(/^\/+|\/+$/g, ''),
    projectRef,
    supabaseUrl: raw.SUPABASE_URL ?? null,
    hasServiceRoleKey: !!raw.SUPABASE_SERVICE_ROLE_KEY,
    allowedMime: raw.STORAGE_ALLOWED_MIME.split(',').map((m) => m.trim()).filter(Boolean),
    localDir: raw.STORAGE_LOCAL_DIR,
    maxUploadBytes: raw.MAX_UPLOAD_BYTES,
    signedUrlTtlSeconds: raw.SIGNED_URL_TTL_SECONDS,
  },
} as const

export type Env = typeof env
export type StorageConfig = typeof env.storage
