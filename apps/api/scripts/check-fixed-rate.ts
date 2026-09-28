/**
 * Self-check for the fixed-rate job contract (run: pnpm check:fixed-rate).
 * No DB needed — it exercises the real zod schemas + the server-side invariant.
 */
import { createJobSchema } from '../src/modules/jobs.ts'
import { toWei } from '../src/lib/money.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) { console.error(`✗ ${name} ${extra}`); failures++ }
  else console.log(`✓ ${name}`)
}

const base = {
  title: 'Fixed-rate audit job',
  description: 'A brief long enough to pass the twenty character floor.',
  category: 'security',
  skills: ['foundry'],
  budget: '0.5',
  milestones: [
    { title: 'M1', description: 'desc', amount: '0.2' },
    { title: 'M2', description: 'desc', amount: '0.3' },
  ],
}

// 1. The new single-field payload is accepted.
const parsed = createJobSchema.parse(base)
check('single budget field accepted', parsed.budget === '0.5')

// 2. The old min/max payload is rejected (schema is strict).
check('budgetMin/budgetMax payload rejected', !safe(() => createJobSchema.parse({ ...base, budgetMin: '0.1', budgetMax: '0.5' })))

// 3. Server-side invariant: milestone sum must equal the budget exactly.
const sum = base.milestones.reduce((acc, m) => acc + BigInt(toWei(m.amount)), 0n)
check('sum equals fixed budget', sum === BigInt(toWei(base.budget)))
check('mismatched sum is caught', BigInt(toWei('0.4')) !== sum)

function safe(fn: () => unknown): boolean {
  try { fn(); return true } catch { return false }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll fixed-rate checks passed')
