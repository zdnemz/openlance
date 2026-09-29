/**
 * Dev-only: empty the database (run: pnpm db:flush).
 *
 * `pnpm chain` boots a fresh anvil and deploys new contract addresses on every
 * run, so a mirror left over from the previous boot points at contracts that no
 * longer exist. Resetting the chain without the DB is a half reset; this is the
 * DB half, for when you want the empty state without a redeploy.
 *
 * Truncates every table in `public`, discovered from the live catalog rather
 * than a hardcoded list (a new table in schema.ts can never be missed) and
 * nothing else: the applied migrations live in the `drizzle` schema, Supabase's
 * own tables in `auth`/`storage`. One statement, so it is atomic;
 * `RESTART IDENTITY` resets sequences too. Dropping `indexer_state` rewinds the
 * checkpoint to 0, so the indexer re-mirrors the live chain from genesis.
 *
 * Destructive, and DATABASE_URL is a shared remote Supabase instance in this
 * setup — so it always prints the target and takes a confirmation. Never a bare
 * truncate on a URL someone pasted. `--yes` skips the prompt (CI/agents).
 */
import { createInterface } from 'node:readline/promises'
import { closeDb, execSql } from '../src/db/index.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[db:flush] DATABASE_URL is required (copy .env.example to .env.local)')
  process.exit(1)
}
// host:port only — the URL carries a password.
const target = new URL(url).host

interface Table { tablename: string }

async function confirmed(tables: Table[]): Promise<boolean> {
  if (process.argv.includes('--yes')) return true
  if (!process.stdin.isTTY) {
    console.error('[db:flush] no TTY to confirm on — re-run with --yes')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(
    `[db:flush] about to TRUNCATE ${tables.length} tables on ${target} — every row is gone. Type "flush" to confirm: `,
  )
  rl.close()
  return answer.trim() === 'flush'
}

try {
  const tables = (await execSql(
    "select tablename from pg_tables where schemaname = 'public' order by 1",
  )) as Table[]
  if (!tables.length) {
    console.error('[db:flush] no public tables — is this the right DATABASE_URL?')
    process.exit(1)
  }

  // pg_stat estimate, not count(*): an exact count scans every table just to
  // print a warning line.
  const [size] = (await execSql(
    "select coalesce(sum(n_live_tup), 0)::bigint as rows from pg_stat_user_tables where schemaname = 'public'",
  )) as { rows: string }[]
  console.log(`[db:flush] target ${target} — ${tables.length} public tables, ~${size.rows} rows`)

  if (!(await confirmed(tables))) {
    console.error('[db:flush] aborted, nothing was deleted')
    process.exit(1)
  }

  // Identifier list comes from pg_tables, not user input.
  const names = tables.map((t) => `"${t.tablename}"`).join(', ')
  await execSql(`truncate table ${names} restart identity cascade`)
  console.log(`[db:flush] flushed — restart the API (pnpm dev:api) so the indexer re-reads from block 0`)
} catch (err) {
  console.error(`[db:flush] failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
} finally {
  await closeDb()
}
