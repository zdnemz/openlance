/**
 * Self-check: the cron route's auth gate (run: pnpm check:cron).
 *
 * `GET /api/internal/cron` runs the chain indexer, the SLA scan, webhook
 * delivery and the nightly reconciliation. It is unauthenticated in exactly
 * one sense only: it must be *closed* unless CRON_SECRET is set, and it must
 * reject everything that is not that secret. An open route here is a public
 * "reindex the chain / drain the webhook queue" button, so the three states
 * worth pinning are:
 *
 *   1. secret unset      → 404 (the endpoint does not exist at all)
 *   2. wrong/missing     → 401, and specifically NOT a 500
 *   3. exact match       → passes
 *
 * (2) is the one that regresses quietly. A naive timing-safe compare throws on
 * a length mismatch, which `route()` renders as a 500 — so a wrong-length token
 * would answer "internal error" and tell an attacker they were close.
 *
 * No network and no database: only the guard is exercised.
 */
import { AppError } from '../src/lib/errors.ts'

let failures = 0
function check(name: string, ok: boolean, extra: unknown = '') {
  if (!ok) { console.error(`✗ ${name} ${extra}`); failures++ }
  else console.log(`✓ ${name}`)
}

// config.ts parses process.env ONCE at module load, so the secret must be in
// the environment before anything imports cron.ts. `check:cron` therefore runs
// with CRON_SECRET injected by the npm script rather than assigned here.
const SECRET = process.env.CRON_SECRET
if (!SECRET) {
  console.error('CRON_SECRET is not set — run via `pnpm check:cron`')
  process.exit(1)
}

const { authorizeCron } = await import('../src/modules/cron.ts')

/** Capture what authorizeCron throws, as [status, code]. */
function attempt(token?: string): [number, string] | 'passed' {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  try {
    authorizeCron(new Request('https://api.invalid/api/internal/cron', { headers }))
    return 'passed'
  } catch (err) {
    if (err instanceof AppError) return [err.status, err.code]
    throw err
  }
}

check('exact secret passes', attempt(SECRET) === 'passed')
check('missing header is 401', JSON.stringify(attempt()) === '[401,"unauthorized"]', attempt())
check('wrong secret is 401', JSON.stringify(attempt('nope')) === '[401,"unauthorized"]', attempt('nope'))

// The regression this file exists for: a length mismatch must not become a 500.
const wrongLength = attempt('short')
check(
  'wrong-length secret is 401, not 500',
  JSON.stringify(wrongLength) === '[401,"unauthorized"]',
  wrongLength,
)
check('no Authorization prefix is 401', JSON.stringify(attempt('')) === '[401,"unauthorized"]')

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall cron auth checks passed')
