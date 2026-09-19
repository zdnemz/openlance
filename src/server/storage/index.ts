/**
 * Storage system config — the single source of truth for how uploaded bytes
 * are stored. Two drivers ride one interface:
 *
 *   · supabase — Supabase Storage (production). Objects live in a bucket and
 *     are served via short-lived signed URLs. The admin client uses the
 *     service-role key and is memoized per process.
 *   · local    — disk under STORAGE_LOCAL_DIR, served through this API with
 *     HMAC-signed download URLs (zero-infra dev).
 *
 * Everything here derives from `env.storage` (see ../config.ts). Consumers ask
 * this module for the resolved config, the memoized client, and health probes —
 * they never read raw env vars or construct clients themselves.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { env, type StorageConfig } from '../config'
import { logger } from '../lib/logger'

export type StorageDriver = 'supabase' | 'local'

/**
 * Built-in MIME allowlist (PRD F7): pdf / images / zip / docs / code.
 * STORAGE_ALLOWED_MIME overrides this entirely when set.
 */
export const DEFAULT_MIME_ALLOWLIST: readonly string[] = [
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'text/x-typescript', 'text/javascript', 'application/typescript',
  'text/x-python', 'text/x-rust', 'text/x-go', 'text/x-sol', 'text/x-sql',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

/** Resolved, non-secret storage configuration for consumers + introspection. */
export interface ResolvedStorageConfig {
  driver: StorageDriver
  configured: boolean
  bucket: string
  visibility: 'private' | 'public'
  prefix: string
  projectRef: string | null
  supabaseUrl: string | null
  localDir: string
  maxUploadBytes: number
  signedUrlTtlSeconds: number
  allowedMime: readonly string[]
}

/** The storage config in effect, derived from the environment once. */
export function storageConfig(): ResolvedStorageConfig {
  const c: StorageConfig = env.storage
  return {
    driver: c.driver,
    configured: c.configured,
    bucket: c.bucket,
    visibility: c.visibility,
    prefix: c.prefix,
    projectRef: c.projectRef,
    supabaseUrl: c.supabaseUrl,
    localDir: c.localDir,
    maxUploadBytes: c.maxUploadBytes,
    signedUrlTtlSeconds: c.signedUrlTtlSeconds,
    allowedMime: c.allowedMime.length ? c.allowedMime : DEFAULT_MIME_ALLOWLIST,
  }
}

/** True when a MIME type is permitted by the active allowlist. */
export function isMimeAllowed(mime: string): boolean {
  return storageConfig().allowedMime.includes(mime)
}

/** True when the Supabase driver is selected AND has real credentials. */
export function isSupabaseStorage(): boolean {
  return storageConfig().driver === 'supabase' && !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Apply the global object-key prefix and normalise slashes. All writes/reads
 * must run through this so the prefix stays consistent.
 */
export function storageKey(path: string): string {
  const clean = path.replace(/^\/+/, '')
  const prefix = storageConfig().prefix
  return prefix ? `${prefix}/${clean}` : clean
}

/* ── Supabase admin client (memoized) ──────────────────────────────────────── */

let client: SupabaseClient | null = null

/**
 * Memoized Supabase Storage admin client. The service-role key bypasses RLS,
 * so this must never be imported into client code. Created lazily (dynamic
 * import) to keep `@supabase/supabase-js` off cold paths that never touch
 * storage, and memoized per process.
 */
export async function supabaseAdmin(): Promise<SupabaseClient> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase storage is not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)')
  }
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js')
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'openlance-api' } },
    })
    logger.info('storage: supabase admin client initialised', {
      bucket: env.STORAGE_BUCKET, projectRef: env.storage.projectRef,
    })
  }
  return client
}

/* ── Health probe ──────────────────────────────────────────────────────────── */

/**
 * Lightweight readiness probe for the storage layer. For supabase we hit the
 * bucket's metadata endpoint (cheap, no listing of user data); for local we
 * just confirm the driver is configured. Never throws — returns a status line.
 */
export async function probeStorage(): Promise<string> {
  const cfg = storageConfig()
  if (cfg.driver === 'local') return 'ok (local)'
  if (!cfg.configured) return 'down (supabase unconfigured)'
  try {
    const { error } = await (await supabaseAdmin()).storage.getBucket(cfg.bucket)
    if (error) return `down (${error.message})`
    return `ok (supabase:${cfg.bucket})`
  } catch (err) {
    return `down (${err instanceof Error ? err.message : 'unknown'})`
  }
}
