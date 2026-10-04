/**
 * Webhook targets must be public: deliveries run from inside our network, so
 * an internal URL (loopback, private, cloud metadata) was an SSRF probe.
 *
 *   pnpm --filter @openlance/api check:webhook-url
 */
import { assertPublicUrl, isPrivateAddress } from '../src/domain/webhooks.ts'

let failed = 0
const check = (name: string, ok: boolean) => { if (ok) console.log(`  ok  ${name}`); else { failed++; console.error(`  FAIL ${name}`) } }

for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
  check(`${ip} is private`, isPrivateAddress(ip))
}
for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) check(`${ip} is public`, !isPrivateAddress(ip))

const refused = async (url: string) => assertPublicUrl(url).then(() => false, () => true)
check('http://localhost:8545 is refused', await refused('http://localhost:8545'))
check('http://[::1]/ is refused', await refused('http://[::1]/'))
check('ftp:// is refused', await refused('ftp://example.com/'))
check('development may target localhost', !(await assertPublicUrl('http://localhost:9000', true).then(() => false, () => true)))

if (failed) process.exit(1)
console.log('all webhook-url checks passed')
