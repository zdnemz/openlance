/**
 * Regression check for the on-chain seat.
 *
 * The bug: a wallet had claimed `arbiter` on-chain, the database was reset, and
 * the sign-in came back with the `users.role` column default (`client`). The
 * row looked like a brand-new account, so onboarding offered all three seats
 * and the wallet could take a different one — for free, forever, once per wipe.
 *
 * The rule that prevents it: `users.role` is a MIRROR. It may only ever hold a
 * seat the wallet has already claimed on-chain. This exercises that rule —
 * `verifySeatClaim`, the one decision every role write passes through — plus
 * the ordinal mapping it decodes.
 *
 * Pure check — no chain, no database.
 *
 *   pnpm --filter @openlance/api check:role-seat
 */
import { verifySeatClaim, ROLE_ORDINAL, type SeatRead } from '../src/chain/role-registry.ts'
import { AppError } from '../src/lib/errors.ts'

let failed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`)
  }
}
function expectThrow(fn: () => void, code: string) {
  try {
    fn()
  } catch (err) {
    if (!(err instanceof AppError)) throw new Error(`expected an AppError, got ${String(err)}`)
    if (err.code !== code) throw new Error(`expected code "${code}", got "${err.code}" (${err.message})`)
    return
  }
  throw new Error(`expected the write to be refused with "${code}" — it was allowed`)
}
function allows(read: SeatRead, role: 'client' | 'freelancer' | 'arbiter') {
  try {
    verifySeatClaim(read, role)
  } catch (err) {
    throw new Error(`expected ${role} to be allowed for ${JSON.stringify(read)}, got: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log('the seat is a mirror of RoleRegistry')

check('the claimed seat can be mirrored', () => {
  allows({ state: 'claimed', role: 'arbiter' }, 'arbiter')
  allows({ state: 'claimed', role: 'client' }, 'client')
})
check('a claimed seat cannot be changed for free (the wipe bug)', () => {
  // Exactly the reported case: claimed `arbiter` on-chain, the column says
  // `client` after the reset, onboarding offers to pick again.
  expectThrow(() => verifySeatClaim({ state: 'claimed', role: 'arbiter' }, 'client'), 'seat_locked')
  expectThrow(() => verifySeatClaim({ state: 'claimed', role: 'arbiter' }, 'freelancer'), 'seat_locked')
})
check('an unclaimed wallet must claim on-chain first', () => {
  expectThrow(() => verifySeatClaim({ state: 'none' }, 'client'), 'seat_not_claimed')
})
check('an unreadable registry fails closed, not open', () => {
  // The dangerous default: treating "we could not ask" as "nothing claimed"
  // makes an RPC outage a free seat change for everyone signing in during it.
  expectThrow(() => verifySeatClaim({ state: 'unreadable' }, 'arbiter'), 'seat_unreadable')
})
check('a deployment with no on-chain seat is decided by the column', () => {
  allows({ state: 'off' }, 'client')
  allows({ state: 'off' }, 'arbiter')
})
check('ordinals match IRoleRegistry.Role', () => {
  if (ROLE_ORDINAL.client !== 1) throw new Error(`client is ${ROLE_ORDINAL.client}, expected 1`)
  if (ROLE_ORDINAL.freelancer !== 2) throw new Error(`freelancer is ${ROLE_ORDINAL.freelancer}, expected 2`)
  if (ROLE_ORDINAL.arbiter !== 3) throw new Error(`arbiter is ${ROLE_ORDINAL.arbiter}, expected 3`)
})

if (failed) {
  console.error(`\n${failed} check(s) failed — the seat is not mirror-only again.`)
  process.exit(1)
}
console.log('\nall seat checks passed')
