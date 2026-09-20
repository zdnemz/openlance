/**
 * Database access — Drizzle over Supabase Postgres (postgres-js driver).
 *
 * The API always connects with privileged credentials and IS the write path.
 * (RLS bootstrap was removed — any policies on the env database are managed
 * in the Supabase dashboard, not this repo.)
 * A module-scoped singleton keeps the pool alive across Next.js invocations in
 * the same server process (dev/hot-reload safe).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config'
import { logger } from '../lib/logger'
import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export type { schema }

const globalForDb = globalThis as unknown as {
  __openlance_db?: Db
  __openlance_pg?: import('postgres').Sql
}

function requireUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (Supabase Postgres connection string)')
  }
  return env.DATABASE_URL
}

export function getDb(): Db {
  if (globalForDb.__openlance_db) return globalForDb.__openlance_db
  const client = postgres(requireUrl(), { max: env.DATABASE_POOL_MAX, prepare: false })
  globalForDb.__openlance_pg = client
  const db = drizzle(client, { schema }) as unknown as Db
  globalForDb.__openlance_db = db
  logger.info('DB: postgres (supabase)', { url: requireUrl().replace(/:\/\/.*@/, '://***@') })
  return db
}

/** Raw SQL execution (migrations, RLS bootstrap, report queries). */
export async function execSql(sqlText: string): Promise<unknown> {
  const client = globalForDb.__openlance_pg
  if (!client) {
    getDb() // initialise
  }
  return globalForDb.__openlance_pg!.unsafe(sqlText)
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__openlance_pg) await globalForDb.__openlance_pg.end({ timeout: 5 }).catch(() => {})
  globalForDb.__openlance_db = undefined
  globalForDb.__openlance_pg = undefined
}
