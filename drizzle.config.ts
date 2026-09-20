import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for the Next.js server runtime.
 * Push schema straight to the env database — no versioned migration files:
 *   DATABASE_URL=postgresql://... bunx drizzle-kit push
 */
export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
