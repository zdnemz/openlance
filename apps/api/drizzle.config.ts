import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for the API service.
 *
 * Versioned migrations, not `drizzle-kit push`:
 *   pnpm db:generate   # diff src/db/schema.ts against drizzle/meta → new .sql
 *   pnpm db:migrate    # apply pending migrations in order
 *
 * `push` diffs the schema straight against the live database. It never wrote to
 * `drizzle/`, so the migration files there were decorative — unreviewed,
 * unapplied, and one `rm -rf drizzle` from gone. A schema change is now a
 * reviewable SQL file plus an ordered, replayable history.
 *
 * `.env.local` is a symlink to the repo-root env file, created by the root
 * `postinstall`, so `process.loadEnvFile` finds it from this package's cwd.
 * The try/catch keeps CI working: there is no env file there, and DATABASE_URL
 * arrives from the environment instead.
 */
try {
  process.loadEnvFile('.env.local')
} catch {
  // No local env file (CI, container) — DATABASE_URL comes from the environment.
}

if (!process.env.DATABASE_URL) {
  console.error('[drizzle] DATABASE_URL is required. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
})
