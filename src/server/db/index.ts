/**
 * Database access — Drizzle over Supabase Postgres (postgres-js driver).
 *
 * The API always connects with privileged credentials and IS the write path;
 * RLS (db/rls.sql) constrains direct authenticated reads via PostgREST/Realtime.
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
  __escrowlance_db?: Db
  __escrowlance_pg?: import('postgres').Sql
}

function requireUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (Supabase Postgres connection string)')
  }
  return env.DATABASE_URL
}

export function getDb(): Db {
  if (globalForDb.__escrowlance_db) return globalForDb.__escrowlance_db
  const client = postgres(requireUrl(), { max: env.DATABASE_POOL_MAX, prepare: false })
  globalForDb.__escrowlance_pg = client
  const db = drizzle(client, { schema }) as unknown as Db
  globalForDb.__escrowlance_db = db
  logger.info('DB: postgres (supabase)', { url: requireUrl().replace(/:\/\/.*@/, '://***@') })
  return db
}

/** Raw SQL execution (migrations, RLS bootstrap, report queries). */
export async function execSql(sqlText: string): Promise<unknown> {
  const client = globalForDb.__escrowlance_pg
  if (!client) {
    getDb() // initialise
  }
  return globalForDb.__escrowlance_pg!.unsafe(sqlText)
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__escrowlance_pg) await globalForDb.__escrowlance_pg.end({ timeout: 5 }).catch(() => {})
  globalForDb.__escrowlance_db = undefined
  globalForDb.__escrowlance_pg = undefined
}
