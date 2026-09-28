/**
 * One env file for the whole monorepo.
 *
 * Next.js only reads `.env*` from its own directory, and `pnpm -r` runs each
 * script with cwd set to that package — so a root `.env.local` would reach
 * neither app. Symlinking it into each package keeps ONE file to edit (no
 * drift between copies) while every process finds it at the path its loader
 * expects: Next for the web app, `process.loadEnvFile` and
 * `--env-file-if-exists` for the API.
 *
 * Skipped in CI and containers, where there is no root .env.local and the
 * environment arrives from the platform instead. A real (non-symlink) file in
 * a package is treated as a deliberate local override and left untouched.
 */
import { existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, '.env.local')
const TARGETS = ['apps/web', 'apps/api']

const lstatOrNull = (p) => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

if (!existsSync(SOURCE)) {
  console.log('[link-env] no root .env.local — skipping (CI/container, or not set up yet)')
} else {
  for (const dir of TARGETS) {
    const link = join(ROOT, dir, '.env.local')
    const existing = lstatOrNull(link)
    if (existing && !existing.isSymbolicLink()) continue // real file = local override
    if (existing) unlinkSync(link) // stale link
    symlinkSync(join('..', '..', '.env.local'), link)
    console.log(`[link-env] ${dir}/.env.local → ../../.env.local`)
  }
}
