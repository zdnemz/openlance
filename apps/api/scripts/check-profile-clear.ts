/**
 * Regression check for clearing a profile field.
 *
 * Both spellings of "clear" used to be no-ops, so a name or bio could never be
 * unset once set:
 *
 *   1. The server required `min(1)`, so sending "" was a 400.
 *   2. The form sent `|| undefined`, which omits the key — and an omitted key
 *      means "leave unchanged", not "set to null".
 *
 * The user emptied the field, hit Save, and the old value came back with no
 * error anywhere. `skills` was the only clearable field, because it always
 * ships as an array.
 *
 * Pure schema check — no chain, no database.
 *
 *   pnpm --filter @openlance/api check:profile-clear
 */
import { z } from 'zod'
import { clearable } from '../src/modules/users.ts'

/**
 * Built from the REAL helper, not a copy — a mirrored schema is exactly how
 * this class of bug comes back unnoticed.
 */
const profilePatch = z.object({
  displayName: clearable(80).optional(),
  bio: clearable(2000).optional(),
  skills: z.array(z.string().min(1).max(40)).max(20).optional(),
  links: z.record(z.string(), z.string().url()).optional(),
})

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
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('clearing a profile field')

check('empty string clears the name', () => {
  eq(profilePatch.parse({ displayName: '' }).displayName, null, 'displayName')
})
check('empty string clears the bio', () => {
  eq(profilePatch.parse({ bio: '' }).bio, null, 'bio')
})
check('whitespace-only clears rather than storing "   "', () => {
  eq(profilePatch.parse({ bio: '   \n ' }).bio, null, 'bio')
  eq(profilePatch.parse({ displayName: '  ' }).displayName, null, 'displayName')
})
check('explicit null clears', () => {
  eq(profilePatch.parse({ displayName: null }).displayName, null, 'displayName')
})
check('a real value survives, trimmed', () => {
  eq(profilePatch.parse({ displayName: '  zidane  ' }).displayName, 'zidane', 'displayName')
  eq(profilePatch.parse({ bio: ' ships contracts ' }).bio, 'ships contracts', 'bio')
})
check('omitted key still means "leave unchanged"', () => {
  // This is the distinction that made the bug invisible: absent !== empty.
  const out = profilePatch.parse({ skills: [] })
  if ('displayName' in out) throw new Error('absent displayName must not become an explicit clear')
})
check('length caps still reject at the boundary', () => {
  eq(profilePatch.safeParse({ displayName: 'x'.repeat(81) }).success, false, '81-char name must be rejected')
  eq(profilePatch.safeParse({ bio: 'x'.repeat(2001) }).success, false, '2001-char bio must be rejected')
  eq(profilePatch.safeParse({ displayName: 'x'.repeat(80) }).success, true, '80-char name must pass')
})
check('links are still URL-validated', () => {
  eq(profilePatch.safeParse({ links: { github: 'not-a-url' } }).success, false, 'bad link URL must be rejected')
  eq(profilePatch.safeParse({ links: { github: 'https://github.com/x' } }).success, true, 'good link must pass')
})
check('skills still clear with an empty array', () => {
  eq(profilePatch.parse({ skills: [] }).skills.length, 0, 'skills')
})

if (failed) {
  console.error(`\n${failed} check(s) failed — clearing a profile field is broken again.`)
  process.exit(1)
}
console.log('\nall clear checks passed')
