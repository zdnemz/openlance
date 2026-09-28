import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for the API service.
 * Push schema straight to the env database — no versioned migration files:
 *   DATABASE_URL=postgresql://... pnpm db:migrate
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
