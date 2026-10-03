/**
 * The relayer pays only for OpenLance's contracts, and only up to a gas cap.
 * Before this guard it forwarded any calldata to any address with any gas.
 *
 *   pnpm --filter @openlance/api check:sponsorable
 */
process.env.CHAIN_MODE = 'real'
process.env.ESCROW_ADDRESS = '0x' + '11'.repeat(20)
process.env.ARBITER_REGISTRY_ADDRESS = '0x' + '22'.repeat(20)
delete process.env.ROLE_REGISTRY_ADDRESS

const { assertSponsorable } = await import('../src/modules/sponsorship.ts')

let failed = 0
function check(name: string, fn: () => void, refused: boolean) {
  let threw = false
  try { fn() } catch { threw = true }
  if (threw === refused) console.log(`  ok  ${name}`)
  else { failed++; console.error(`  FAIL ${name}`) }
}

check('escrow is sponsorable', () => assertSponsorable('0x' + '11'.repeat(20), '1000000'), false)
check('registry is sponsorable (case-insensitive)', () => assertSponsorable('0x' + '22'.repeat(20).toUpperCase(), '1000000'), false)
check('any other contract is refused', () => assertSponsorable('0x' + '33'.repeat(20), '1000000'), true)
check('gas above the cap is refused', () => assertSponsorable('0x' + '11'.repeat(20), '30000000'), true)

if (failed) process.exit(1)
console.log('all sponsorable checks passed')
