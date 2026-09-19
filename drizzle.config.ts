import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for the Next.js server runtime.
 * Generate: bunx drizzle-kit generate
 * Apply:    bun scripts/migrate.ts
 */
export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
