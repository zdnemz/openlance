/**
 * Apply Drizzle migrations + RLS/realtime bootstrap to Supabase Postgres.
 *
 *   bun scripts/migrate.ts        (or)  npx tsx scripts/migrate.ts
 *
 * Reads DATABASE_URL from the environment (see .env.example).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate as pgMigrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDb, execSql, getDb } from '../src/server/db'

async function main() {
  const db = getDb()
  await pgMigrate(db as never, { migrationsFolder: './drizzle' })
  console.log('[migrate] drizzle migrations applied')

  for (const file of ['db/rls.sql', 'db/realtime.sql']) {
    const sql = await readFile(join(process.cwd(), file), 'utf8')
    await execSql(sql)
    console.log(`[migrate] applied ${file}`)
  }
  await closeDb()
  console.log('[migrate] done')
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
