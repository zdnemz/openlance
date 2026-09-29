/**
 * Self-check for the job-post / bid contract (run: pnpm check:job-bid).
 * No DB needed — it exercises the real zod schemas on both sides of the flow.
 *
 * The rule this file exists to pin: a job post is a brief plus a ceiling, and a
 * bid is the freelancer's own breakdown and price, capped at that ceiling. The
 * milestone sum invariant that used to live here ("sum == budget") is gone with
 * the template — the one budget rule left is the ceiling.
 */
import { createJobSchema } from '../src/modules/jobs.ts'
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

// 6. The one budget rule left: a bid at the ceiling is fundable, above it is not.
const CEILING_WEI = BigInt(toWei('0.5'))
check('a bid at the ceiling is accepted', !bidExceedsCeiling(BigInt(toWei('0.5')), CEILING_WEI))
check('a bid under the ceiling is accepted', !bidExceedsCeiling(BigInt(toWei('0.3')), CEILING_WEI))
check('a bid over the ceiling is rejected', bidExceedsCeiling(BigInt(toWei('0.5000001')), CEILING_WEI))

function safe(fn: () => unknown): boolean {
  try { fn(); return true } catch { return false }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll job-post / bid checks passed')
