/**
 * Database access — one Drizzle schema, two drivers:
 *  - 'pglite' : embedded Postgres (WASM) persisted to ./data — zero-infra dev/demo
 *  - 'postgres': any real Postgres, i.e. a Supabase project (DATABASE_URL)
 * The API always connects with privileged credentials and IS the write path;
 * RLS (db/rls.sql) constrains direct authenticated reads via PostgREST/Realtime.
 */
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePg, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { env } from '../config'
import { logger } from './logger'
import * as schema from '../db/schema'

export type Db = PostgresJsDatabase<typeof schema>

let dbInstance: Db | undefined
let pgliteInstance: import('@electric-sql/pglite').PGlite | undefined
let pgClient: import('postgres').Sql | undefined

export async function getDb(): Promise<Db> {
  if (dbInstance) return dbInstance
  if (env.databaseDriver === 'postgres') {
    const { default: postgres } = await import('postgres')
    pgClient = postgres(env.DATABASE_URL!, { max: 10, prepare: false })
    dbInstance = drizzlePg(pgClient, { schema }) as unknown as Db
    logger.info('DB: postgres (external)', { url: env.DATABASE_URL!.replace(/:\/\/.*@/, '://***@') })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    // ':memory:' → true in-memory instance (PGlite treats arbitrary strings as dataDirs)
    pgliteInstance = env.PGLITE_DATA_DIR === ':memory:' ? new PGlite() : new PGlite(env.PGLITE_DATA_DIR)
    dbInstance = drizzlePglite(pgliteInstance, { schema }) as unknown as Db
    logger.info('DB: pglite (embedded)', { dir: env.PGLITE_DATA_DIR })
  }
  return dbInstance
}

/** Raw SQL execution (migrations, RLS bootstrap, report queries). */
export async function execSql(sqlText: string): Promise<unknown> {
  if (pgliteInstance) return pgliteInstance.exec(sqlText)
  if (pgClient) return pgClient.unsafe(sqlText)
  throw new Error('Database not initialised')
}

export async function closeDb(): Promise<void> {
  if (pgliteInstance) await pgliteInstance.close().catch(() => {})
  if (pgClient) await pgClient.end({ timeout: 5 }).catch(() => {})
  dbInstance = undefined
  pgliteInstance = undefined
  pgClient = undefined
}
