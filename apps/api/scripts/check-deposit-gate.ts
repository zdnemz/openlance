/**
 * The publish gate: the budget has to be locked under this job's ref, by the
 * poster, covering the whole ceiling.
 *
 *   pnpm --filter @openlance/api check:deposit-gate
 *
 * The poster side of the check is the escrow's OWN record (`budgetLocker`),
 * never `tx.from`. Escrow is ERC-2771 aware, so a sponsored deposit is
 * submitted by the relayer and a smart account's by a bundler — and reading
 * tx.from rejected the poster's own deposit as "not the poster wallet". So the
 * rule here is about what the escrow recorded, not about who submitted.
 */
import { depositCovers } from '../src/modules/jobs.ts'

const POSTER = '0xAaAa000000000000000000000000000000000001'
const OTHER = '0x' + '99'.repeat(20)
const CEILING = 1_000_000_000_000_000_000n // 1 ETH
const same = POSTER.toLowerCase()

let failed = 0
const check = (name: string, ok: boolean) => { if (ok) console.log(`  ok  ${name}`); else { failed++; console.error(`  FAIL ${name}`) } }

check('the recorded locker is the poster (checksum vs lowercase)', depositCovers(POSTER, same, CEILING, CEILING))
check('a fully covered ceiling publishes', depositCovers(same, POSTER, CEILING * 2n, CEILING))
check('one wei short of the ceiling does not', !depositCovers(same, POSTER, CEILING - 1n, CEILING))
check('a budget somebody else locked does not', !depositCovers(OTHER, POSTER, CEILING, CEILING))
check('nothing left under the key does not', !depositCovers(same, POSTER, 0n, CEILING))

if (failed) process.exit(1)
console.log('all deposit-gate checks passed')