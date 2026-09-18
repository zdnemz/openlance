/**
 * Apply drizzle-kit migrations + RLS/realtime bootstrap.
 * Works for both drivers (PGlite embedded / external Postgres via DATABASE_URL).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config'
import { logger } from '../lib/logger'
import { closeDb, execSql, getDb } from '../lib/db'

async function migrate() {
  const db = await getDb()
  if (env.databaseDriver === 'postgres') {
    const { migrate: pgMigrate } = await import('drizzle-orm/postgres-js/migrator')
    await pgMigrate(db as never, { migrationsFolder: './drizzle' })
  } else {
    const { migrate: pgliteMigrate } = await import('drizzle-orm/pglite/migrator')
    await pgliteMigrate(db as never, { migrationsFolder: './drizzle' })
  }
  logger.info('drizzle migrations applied')

  for (const file of ['db/rls.sql', 'db/realtime.sql']) {
    const sql = await readFile(join(process.cwd(), file), 'utf8')
    await execSql(sql)
    logger.info(`applied ${file}`)
  }
  await closeDb()
}

migrate().catch((err) => {
  console.error('migration failed:', err)
  process.exit(1)
})
