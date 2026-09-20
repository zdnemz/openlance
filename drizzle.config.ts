import { defineConfig } from 'drizzle-kit'
import { loadEnvConfig } from '@next/env'

/**
 * Drizzle Kit config for the Next.js server runtime.
 * Push schema straight to the env database — no versioned migration files:
 *   DATABASE_URL=postgresql://... bunx drizzle-kit push
 *
 * Next.js stores local secrets in `.env.local`, which plain `drizzle-kit`
 * does not load on its own — so we reuse Next's loader to populate
 * `process.env` (including `.env.local`) before reading DATABASE_URL.
 */
loadEnvConfig(process.cwd())

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
