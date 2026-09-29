/**
 * Self-check for the job-post / bid contract (run: pnpm check:job-bid).
 * No DB needed — it exercises the real zod schemas on both sides of the flow.
 *
 * The rule this file exists to pin: a job post is a brief plus a ceiling (which
 * is also what gets locked at publish), and a bid is the freelancer's own
 * breakdown and price, capped at that ceiling. The milestone sum invariant that
 * used to live here ("sum == budget") is gone with the template — the budget
 * rules left are the ceiling on a bid and the lock it draws from.
 */
import { createJobSchema, deletableByFunding } from '../src/modules/jobs.ts'
import { proposalSchema, bidExceedsCeiling } from '../src/modules/proposals.ts'
import { toWei } from '../src/lib/money.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) { console.error(`✗ ${name} ${extra}`); failures++ }
  else console.log(`✓ ${name}`)
}

const base = {
  title: 'Invariant fuzz audit for a bridge',
  description: 'A brief long enough to pass the twenty character floor.',
  category: 'security',
  skills: ['foundry'],
  budget: '0.5',
}

// 1. The post itself: a brief and a single ceiling number, nothing else.
const parsed = createJobSchema.parse(base)
check('job post accepts brief + ceiling', parsed.budget === '0.5' && parsed.milestones === undefined)

// 2. A client can no longer dictate a breakdown. The schema is strict, so a
//    payload carrying milestones is rejected outright rather than ignored.
check('milestone template in a job post is rejected',
  !safe(() => createJobSchema.parse({ ...base, milestones: [{ title: 'M1', description: 'd', amount: '0.2' }] })))

// 3. The old min/max payload is gone too.
check('budgetMin/budgetMax payload rejected',
  !safe(() => createJobSchema.parse({ ...base, budgetMin: '0.1', budgetMax: '0.5' })))

// 4. A malformed ceiling still fails at the edge.
check('non-numeric budget is rejected', !safe(() => createJobSchema.parse({ ...base, budget: 'half an ETH' })))

// 5. The bid is a different schema entirely: the freelancer's own breakdown and
//    price. A bid needs at least one milestone; the client supplies none.
const bid = proposalSchema.parse({
  coverNote: 'A cover note long enough to clear the twenty character floor.',
  deliveryDays: 14,
  milestones: [{ title: 'M1', description: 'desc', amount: '0.3' }],
})
check('a bid carries its own breakdown', bid.milestones.length === 1)
check('a bid with no milestones is rejected', !safe(() => proposalSchema.parse({ ...bid, milestones: [] })))

// 6. The budget rules that remain. The ceiling is both the cap on a bid and
//    the amount locked at publish, so the same comparison governs an award
//    drawing against that lock — and whatever the bid doesn't use stays
//    withdrawable, which is why the client locks the ceiling and not the price.
const CEILING_WEI = BigInt(toWei('0.5'))
check('a bid at the ceiling is accepted', !bidExceedsCeiling(BigInt(toWei('0.5')), CEILING_WEI))
check('a bid under the ceiling is accepted', !bidExceedsCeiling(BigInt(toWei('0.3')), CEILING_WEI))
check('a bid over the ceiling is rejected', bidExceedsCeiling(BigInt(toWei('0.5000001')), CEILING_WEI))
check('a 0.3 bid draws 0.2 of surplus from a 0.5 lock',
  BigInt(toWei('0.5')) - BigInt(toWei('0.3')) === BigInt(toWei('0.2')))

// 7. Deleting a job is only safe once nothing is left locked under its escrow
//    key: bytes32(job.id) is unrecoverable once the row is gone, so any ETH
//    still locked there would be stranded forever. This is the guard itself.
check('a fully withdrawn job is deletable', deletableByFunding(0n).ok)
check('an unreadable chain (mock mode) is deletable', deletableByFunding(null).ok)
const lockedVerdict = deletableByFunding(BigInt(toWei('0.2')))
check('a job with a live lock is not deletable',
  !lockedVerdict.ok && lockedVerdict.reason === 'funding_locked' && lockedVerdict.freeWei === toWei('0.2'))

function safe(fn: () => unknown): boolean {
  try { fn(); return true } catch { return false }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll job-post / bid checks passed')
