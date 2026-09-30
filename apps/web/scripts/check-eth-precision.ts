/**
 * ETH amounts must READ as the value the user signs for.
 *
 * `formatEth` twice reported a real amount as something else: first a flat "0"
 * (a 0.0004 ETH bid), then a hardcoded "<0.001" that ignored `maxDecimals`
 * entirely — so a 0.0005 ETH milestone showed "<0.001 ETH" for its value, its
 * fee AND its payout, and the fee/payout split could not be checked at all.
 *
 * This pins the contract of the formatter: the precision it reports at, the
 * value it prints, and — the part that actually matters — that the printed fee
 * and payout still add up to the printed value.
 */
import assert from 'node:assert/strict'
import { formatEth, toWei, feeOn } from '../lib/format.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── ordinary amounts keep reading as before ────────────────────────────────
check('0.5 ETH reads as 0.5, not 0.500000', formatEth('500000000000000000') === '0.5', formatEth('500000000000000000'))
check('2 ETH reads as 2, not 2.000000', formatEth('2000000000000000000') === '2', formatEth('2000000000000000000'))
check('10 ETH reads as 10', formatEth('10000000000000000000') === '10')
check('zero reads as 0', formatEth('0') === '0')
check('an absent amount is an em dash', formatEth(null) === '—' && formatEth(undefined) === '—' && formatEth('') === '—')
check('garbage is an em dash, not NaN', formatEth('not-a-number') === '—')
check('bigint input works like string input', formatEth(500000000000000000n) === '0.5')

// ── the reported bug: sub-0.001 amounts must be legible ────────────────────
check('0.0005 ETH reads as 0.0005', formatEth('500000000000000') === '0.0005', formatEth('500000000000000'))
check('0.0004 ETH reads as 0.0004', formatEth('400000000000000') === '0.0004', formatEth('400000000000000'))
check('0.0025 ETH reads as 0.0025', formatEth('2500000000000000') === '0.0025', formatEth('2500000000000000'))
check('0.00005 ETH is not hidden', formatEth('50000000000000') === '0.00005', formatEth('50000000000000'))

// ── no floor marker, ever: every wei amount is exactly representable ───────
check('the default never returns a "<" placeholder', !formatEth('500000000000000').includes('<'))
check(
  'a 250bps fee on a sub-0.001 milestone is legible, not "<0.000001"',
  formatEth('12500000000000') === '0.0000125',
  formatEth('12500000000000'),
)
check('1 wei is shown exactly', formatEth('1') === '0.000000000000000001', formatEth('1'))
check('18 decimals is the whole story for a wei-level amount', formatEth('1').split('.')[1].length === 18)

// A caller may still ask for coarser precision; that is a deliberate display
// choice, and it must not silently UNDERSTATE — the cap is only ever used by a
// caller that opted in.
check('a caller can still ask for 3 decimals', formatEth('2500000000000000', 3) === '0.002', formatEth('2500000000000000', 3))

// ── the split a client relies on: fee + payout === value ────────────────────
// This is what the milestone panel renders, and the reason the bug was visible.
for (const [amount, bps] of [
  ['500000000000000', 250],
  ['2500000000000000', 250],
  ['1000000000000000', 250],
  ['1000000000000000000', 250],
  ['500000000000000', 500],
  ['1', 250],
  ['7', 100],
] as const) {
  const fee = feeOn(amount, bps)
  const payout = toWei(amount) - fee
  const shownValue = formatEth(amount)
  const shownFee = formatEth(fee)
  const shownPayout = formatEth(payout)
  // Round-trip through ETH text, the way a reader would check the split by
  // hand. `toWei` parses INTEGER wei, not ETH text, so read the decimals back
  // explicitly: "0.025" → 25000000000000000 wei.
  const readEth = (s: string): bigint => {
    const neg = s.startsWith('-')
    const body = neg ? s.slice(1) : s
    const [whole, frac = ''] = body.split('.')
    return BigInt((neg ? '-' : '') + whole + frac.padEnd(18, '0'))
  }
  const sums = readEth(shownValue) === readEth(shownFee) + readEth(shownPayout)
  check(
    `fee + payout === value at ${bps}bps on ${shownValue} ETH`,
    sums,
    `${shownValue} / ${shownFee} / ${shownPayout}`,
  )
  check(
    `every part is legible (not a placeholder) at ${bps}bps on ${shownValue} ETH`,
    shownValue[0] !== '<' && shownFee[0] !== '<' && shownPayout[0] !== '<',
    `${shownValue} / ${shownFee} / ${shownPayout}`,
  )
}

// ── negative amounts (a payout can be negative if the fee exceeds it) ───────
check('a negative amount keeps its sign', formatEth('-1000000000000000') === '-0.001', formatEth('-1000000000000000'))

// ── the threshold string always parses back to something real ──────────────
for (const w of ['500000000000000', '2500000000000000', '50000000000000']) {
  const s = formatEth(w)
  if (s.startsWith('<')) {
    let threw = false
    try { toWei(s) } catch { threw = true }
    check(`the placeholder "${s}" is never fed to a wei parser`, threw === false)
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`)
process.exit(fail ? 1 : 0)
