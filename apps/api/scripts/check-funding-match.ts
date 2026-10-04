/**
 * A MilestoneFunded log links to a milestone only when it pays the agreed
 * amount from the project's client to the project's freelancer. A ref match
 * alone used to flip the row to "funded" — fund(ref, …) is permissionless.
 *
 *   pnpm --filter @openlance/api check:funding-match
 */
import { fundingMatches } from '../src/chain/events.ts'

const want = { client: '0xAaAa000000000000000000000000000000000001', freelancer: '0xbbbb000000000000000000000000000000000002', amountWei: '5000000000000000000' }
const good = { client: want.client.toLowerCase(), freelancer: want.freelancer.toUpperCase().replace('0X', '0x'), amount: want.amountWei }

let failed = 0
const check = (name: string, ok: boolean) => { if (ok) console.log(`  ok  ${name}`); else { failed++; console.error(`  FAIL ${name}`) } }

check('the agreed funding matches (address case ignored)', fundingMatches(good, want))
check('1 wei under the agreed ref does not', !fundingMatches({ ...good, amount: '1' }, want))
check('a payee other than the freelancer does not', !fundingMatches({ ...good, freelancer: '0x' + '99'.repeat(20) }, want))
check('a funder other than the client does not', !fundingMatches({ ...good, client: '0x' + '77'.repeat(20) }, want))

if (failed) process.exit(1)
console.log('all funding-match checks passed')
