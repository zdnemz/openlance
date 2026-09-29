/**
 * Self-check for the server-side sponsored-value backstop
 * (run: pnpm check:sponsored-value).
 *
 * `SponsorshipForwarder.execute` is payable and pays `req.value` out of the
 * RELAYER's balance. While the relay accepted a value-bearing ForwardRequest,
 * an arbiter deposit was funded by the platform: the wallet showed only an
 * EIP-712 signature, the balance never moved, no transfer confirmation
 * appeared, and the stake a slash would consume was the relayer's ETH. Escrow
 * funding and dispute fees failed the same way.
 *
 * The rule: the relayer sponsors GAS only. Every principal transfer — funding,
 * stake deposit/top-up, dispute fee — is a normal user-paid transaction. The
 * browser guard (`canRelayGasless`, apps/web/lib/chain-actions.ts) stops the
 * honest client; assertNoSponsoredValue is what stops the rest, at both relay
 * entry points.
 *
 * The two entry-point assertions drive the REAL exported functions with a
 * value-bearing body and a user id that does not exist: both must refuse before
 * they ever reach the database, so this runs with no DB and no chain.
 */
import {
  assertNoSponsoredValue,
  prepareForwardRequest,
  relayForwardRequest,
} from '../src/modules/sponsorship.ts'
import { AppError } from '../src/lib/errors.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name} ${extra}`); failures++ }
}

/** True when the guard refused with a typed, client-showable 422. */
function refuses(valueWei: string): boolean {
  try {
    assertNoSponsoredValue(valueWei)
    return false
  } catch (err) {
    return err instanceof AppError && err.status === 422 && err.code === 'sponsored_value_not_allowed'
  }
}

const ETH = (10n ** 18n).toString()
const GWEI = 10n ** 9n
const ADDR = '0x1111111111111111111111111111111111111111'
const NOBODY = '00000000-0000-0000-0000-000000000000'

console.log('sponsored relay — principal is never relayed')

// 1. The value-bearing calls that were silently paid by the relayer.
check('arbiter stake deposit refused', refuses(ETH))
check('stake top-up refused', refuses(3n * BigInt(ETH)))
check('escrow funding refused', refuses(250n * BigInt(ETH)))
check('dispute fee refused', refuses(GWEI.toString()))
check('one wei is still a refusal', refuses('1'))

// 2. Zero-value actions keep the gasless UX: submit, vote, unstake, withdraw.
check('zero is relayed', !refuses('0'))
check('omitted value is relayed', !refuses('0'))

// 3. The failure is a typed AppError, not a raw zod throw — a bare ZodError
//    would surface as a 500 from route() and tell the user nothing.
let status = 0
let code = ''
try { assertNoSponsoredValue(ETH) } catch (err) {
  if (err instanceof AppError) { status = err.status; code = err.code }
}
check('refusal is a 422 the UI can show', status === 422 && code === 'sponsored_value_not_allowed', `saw ${status} ${code}`)

// 4. The guard is actually WIRED into both entry points, not just exported: a
//    value-bearing POST /api/relay and POST /api/relay/prepare must both die at
//    the guard. Each call would otherwise fall through to the database (unknown
//    user / unknown session), so the 422 proves the guard ran first.
async function entryRefuses(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof AppError && err.code === 'sponsored_value_not_allowed'
  }
}

check(
  'POST /api/relay refuses a value-bearing request',
  await entryRefuses(() => relayForwardRequest(NOBODY, ADDR, {
    request: {
      from: ADDR, to: ADDR, value: ETH, gas: '1000000', nonce: '0',
      deadline: Math.floor(Date.now() / 1000) + 600, data: '0x',
    },
    sessionId: `0x${'c'.repeat(64)}`,
    signature: `0x${'ab'.repeat(65)}`,
  })),
)

check(
  'POST /api/relay/prepare refuses before asking the client to sign',
  await entryRefuses(() => prepareForwardRequest(NOBODY, ADDR, { to: ADDR, value: ETH, data: '0x' })),
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — a relayed value spends the relayer's ETH, not the user's.`)
  process.exit(1)
}
console.log('\nAll sponsored-value checks passed')
