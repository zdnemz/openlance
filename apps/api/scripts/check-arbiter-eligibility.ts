/**
 * Regression check: /arbiters `eligible` must BE the chain's answer.
 *
 * The roster used to re-derive `ArbiterRegistry.isEligible` off-chain from
 * `env.MIN_STAKE_WEI`, `env.MIN_SCORE_TO_WITHDRAW` and `Date.now()`. All three
 * can disagree with the chain — the floors are live admin-settable state, and
 * `Date.now()` is the *wall* clock while the contract compares `block.timestamp`
 * (the anvil clock drifts; that is what scripts/anvil/repair-clock.mjs is for).
 * So one arbiter read "eligible" on the stake panel, which already called
 * `isEligible` live, and "staked" on the roster that gates the whole UI.
 *
 * Every case below is built so the old derivation returns the OPPOSITE of the
 * chain read, so restoring the mirror fails this script. Thresholds come from
 * `env` rather than hardcoded, so a tuned .env.local still exercises the seam.
 * No chain, no DB.
 *
 *   pnpm --filter @openlance/api check:arbiter-eligibility
 */
import { onchainView } from '../src/modules/arbiters.ts'
import { env } from '../src/config.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`, extra ?? '') }
}

const ADDR = '0x1111111111111111111111111111111111111111'
const HOUR = 3600
const DAY = 86400
const now = Math.floor(Date.now() / 1000)

/** A registered, unstaked-of nothing, full-score arbiter: healthy off-chain. */
const healthy = (stakedAt: number, stakeWei = 5n * 10n ** 18n, trustScore = 100n) => ({
  registered: true,
  unstakeRequested: false,
  tokenId: 1n,
  trustScore,
  stake: stakeWei,
  resolutions: 3n,
  stakedAt: BigInt(stakedAt),
})

const view = (
  info: ReturnType<typeof healthy>,
  eligible: boolean,
  locked: boolean,
  minStakeDuration = 7 * DAY,
) => onchainView(ADDR, info, undefined, 2, minStakeDuration, 0n, eligible, locked)

console.log('\neligibility is read, not derived')

// 1. Wall clock BEHIND the chain: anvil time was warped forward, so the arbiter
//    is past the skin-in-the-game clock ON CHAIN while stakedAt is still in the
//    future for Date.now(). Old code said false; Escrow seats them.
const lagged = view(healthy(now + HOUR), true, false)
check('chain-eligible stays eligible when the wall clock lags', lagged.eligible === true, lagged.eligible)
check('  …with no selectableAfter countdown', lagged.selectableAfter === null, lagged.selectableAfter)

// 2. Admin LOWERED minStake on-chain below the env mirror: the stake is short of
//    env.MIN_STAKE_WEI, which the old `stake >= env` term rejected.
const underEnv = BigInt(env.MIN_STAKE_WEI) / 2n
const lowered = view(healthy(now - 30 * DAY, underEnv), true, false)
check('chain-eligible stays eligible below the env stake floor', lowered.eligible === true, lowered.eligible)

// 3. Admin LOWERED minScoreToWithdraw: the old `trustScore < env` term benched
//    an arbiter the registry still considers good.
const floor = env.MIN_SCORE_TO_WITHDRAW
const rescored = view(healthy(now - 30 * DAY, undefined, BigInt(Math.max(0, floor - 10))), true, false)
check('chain-eligible stays eligible below the env score floor', rescored.eligible === true, rescored.eligible)
check('  …and does not report it locked', rescored.locked === false, rescored.locked)

// 4. Admin RAISED minScoreToWithdraw past a healthy score: isLocked is true, and
//    the old env term would have shown the arbiter as selectable.
const benched = view(healthy(now - 30 * DAY, undefined, BigInt(Math.min(100, floor + 10))), false, true)
check('isLocked is honoured over the env score floor', benched.locked === true, benched.locked)
check('  …and a locked arbiter is not offered as a seat', benched.eligible === false, benched.eligible)

// 5. The registry says no for a reason no single field shows — the on-chain
//    minStakeDuration outruns the stake. selectableAfter must still explain why.
const aged = view(healthy(now - 7 * DAY), false, false, 30 * DAY)
check('a chain-ineligible arbiter reports ineligible', aged.eligible === false, aged.eligible)
check('  …and exposes when it becomes selectable', typeof aged.selectableAfter === 'string', aged.selectableAfter)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
