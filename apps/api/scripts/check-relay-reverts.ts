/**
 * Regression check for the gasless relay's error surface.
 *
 * Two defects both answered `500 Internal server error` on a freelancer
 * submitting work:
 *
 *   1. The forwarder ABI declared only its two write functions, so viem could
 *      not name a single revert the forwarder raises. Every sponsored failure —
 *      an expired session, a stale nonce, a signature OZ's ECDSA rejected,
 *      Escrow refusing `submit` — reached the user undiagnosable. The ABIs are
 *      imported from the source, not copied, so this cannot drift from the fix.
 *   2. The three relay schemas used raw `schema.parse(body)` instead of the
 *      `parseOrThrow` helper, so a malformed body threw a ZodError, which is not
 *      an AppError, which is a 500.
 *
 * Part 1 needs no chain. Part 2 runs against a live API (BASE, default :4000)
 * with a real minted session, and is skipped when no database is reachable.
 *
 *   pnpm --filter @openlance/api check:relay-reverts
 */
import { decodeErrorResult, encodeErrorResult } from 'viem'
import { ESCROW_ERROR_ABI, FORWARDER_ERROR_ABI } from '../src/chain/abi.ts'

const BASE = process.env.BASE ?? 'http://localhost:4000'
const FREELANCER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const SESSION_ID = `0x${'11'.repeat(32)}`
const SIGNATURE = `0x${'22'.repeat(65)}`

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  \u2713 ${name}`) }
  else { fail++; console.log(`  \u2717 ${name}`, extra ?? '') }
}

const roundTrip = (abi: typeof FORWARDER_ERROR_ABI, errorName: string, args: readonly unknown[]): string | null => {
  try {
    const d = decodeErrorResult({ abi, data: encodeErrorResult({ abi, errorName: errorName as never, args: args as never }) })
    return d?.errorName ?? null
  } catch { return null }
}

console.log('\nrevert decoding (forwarder ABI)')
for (const name of [
  'SessionExpired', 'SessionNotYetValid', 'InvalidSession', 'InvalidRequestSignature',
  'InvalidNonce', 'RequestExpired', 'InsufficientRelayerBalance', 'TransferFailed',
  // OZ ECDSA fires from inside the forwarder's recover(), before its own check.
  'ECDSAInvalidSignature',
]) {
  const args = name === 'SessionExpired' || name === 'SessionNotYetValid' ? [1n]
    : name === 'InvalidNonce' ? [1n, 0n]
    : name === 'InvalidSession' ? [`0x${'00'.repeat(32)}`]
    : name === 'RequestExpired' ? [1]
    : []
  check(`${name} decodes`, roundTrip(FORWARDER_ERROR_ABI, name, args) === name)
}

// Escrow's own error must survive the forwarder's CallFailed(returnData)
// wrapper, or the user is told the wrapper's name instead of the real one.
const inner = encodeErrorResult({ abi: ESCROW_ERROR_ABI, errorName: 'WrongStatus', args: [1, 2] })
const wrapped = encodeErrorResult({ abi: FORWARDER_ERROR_ABI, errorName: 'CallFailed', args: [inner] })
let unwrapped: string | null = null
try {
  const outer = decodeErrorResult({ abi: FORWARDER_ERROR_ABI, data: wrapped })
  if (outer?.errorName === 'CallFailed') {
    const payload = (outer.args as readonly unknown[])[0]
    unwrapped = (decodeErrorResult({ abi: ESCROW_ERROR_ABI, data: payload as `0x${string}` }) as { errorName?: string })?.errorName ?? null
  }
} catch { /* asserted below */ }
check('Escrow WrongStatus is recoverable from inside CallFailed', unwrapped === 'WrongStatus', unwrapped)

// A selector neither ABI knows must decode to nothing, so the mapper falls
// through to its named-422 path instead of inventing an error.
let bogus: string | null = 'unset'
try { bogus = decodeErrorResult({ abi: FORWARDER_ERROR_ABI, data: '0xdeadbeef' })?.errorName ?? null } catch { bogus = null }
check('an unknown selector decodes to nothing (falls through to the 422 path)', bogus === null, bogus)

// ── Malformed relay bodies must be 400s, never 500s ──
console.log('\nmalformed relay bodies (live API)')
// Auth is a gate BEFORE the body is parsed, so an anonymous call proves nothing
// about the schema path. Mint a real session; skip rather than fake it.
let token: string | undefined
try {
  const { getDb, closeDb } = await import('../src/db/index.ts')
  const { signSession } = await import('../src/lib/jwt.ts')
  const { eq } = await import('drizzle-orm')
  const { users } = await import('../src/db/schema.ts')
  const [u] = await getDb().select().from(users).where(eq(users.walletAddress, FREELANCER)).limit(1)
  if (u) token = (await signSession({ sub: u.id, address: u.walletAddress })).token
  await closeDb()
} catch (e) {
  console.log('  (no database — skipping:', String(e).slice(0, 90) + ')')
}

const request = {
  from: FREELANCER, to: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  value: '0', gas: '1000000', nonce: '0', deadline: Math.floor(Date.now() / 1000) + 600, data: '0xdeadbeef',
}
const authed = { request, sessionId: SESSION_ID, signature: SIGNATURE }
const cases: Array<[string, string, unknown]> = [
  ['/relay/prepare', 'prepare', { to: 'not-an-address', value: '0', data: '0x' }],
  ['/relay/prepare', 'prepare', { value: '0', data: '0x' }],
  ['/relay/prepare', 'prepare', { to: request.to, value: 0, data: '0x' }],
  ['/relay', 'relay', { sessionId: SESSION_ID, signature: SIGNATURE }],
  ['/relay', 'relay', { ...authed, request: { ...request, deadline: String(request.deadline) } }],
  ['/relay', 'relay', { ...authed, request: { ...request, nonce: 0 } }],
  ['/relay', 'relay', {}],
]

if (!token) {
  console.log('  (skipped — no database session; run with the API + DB up)')
} else {
  for (const [path, label, body] of cases) {
    const res = await fetch(`${BASE}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).catch((e) => ({ status: -1, json: async () => ({ error: { code: String(e).slice(0, 60) } }) }) as Response)
    const json = await res.json().catch(() => ({})) as { error?: { code?: string } }
    check(`${label} rejects a malformed body with 4xx, not 500 (got ${res.status} ${json.error?.code ?? ''})`,
      res.status >= 400 && res.status < 500, { status: res.status, code: json.error?.code })
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
