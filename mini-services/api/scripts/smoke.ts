/**
 * End-to-end smoke test against the RUNNING API (localhost:3030):
 * SIWE login for all four demo wallets → job → proposal → award →
 * fund → submit → approve → reviews → dispute → agree → resolve(split) →
 * SBT score → webhooks → ledger. Exits non-zero on any assertion failure.
 */
import { privateKeyToAccount } from 'viem/accounts'

const API = process.env.SMOKE_API ?? 'http://localhost:3030'
const CHAIN_ID = 84532
const DOMAIN = 'localhost:3000'

const WALLETS = {
  A: { key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', addr: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' }, // client
  B: { key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', addr: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }, // freelancer
  C: { key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', addr: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc' }, // arbiter
  D: { key: '0x92db14e403b83dfe32923f3deaad0034a3ce60bf4eb0e3a0ad63df29e3f0e0e6', addr: '0x8d2cc5f9114234f2af1893997410dd9edd7a1f37' }, // admin
}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}`, extra ?? '')
  }
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { code: string; message: string } }
  return { status: res.status, ...json }
}

async function siweLogin(w: { key: string; addr: string }) {
  const account = privateKeyToAccount(w.key)
  const { data: nonceData } = (await api('GET', '/auth/nonce')) as { data: { nonce: string } }
  const message = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    'Sign in to EscrowLance - milestone escrow for freelance work.',
    '',
    'URI: http://localhost:3000',
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonceData!.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n')
  const signature = await account.signMessage({ message })
  const res = (await api('POST', '/auth/verify', { message, signature })) as { status: number; data?: { token: string; user: { walletAddress: string } } }
  if (res.status !== 201 && res.status !== 200 || !res.data) throw new Error(`login failed: ${JSON.stringify(res)}`)
  return res.data.token
}

console.log('── SIWE login (all four demo wallets)')
const tokenA = await siweLogin(WALLETS.A)
const tokenB = await siweLogin(WALLETS.B)
const tokenC = await siweLogin(WALLETS.C)
const tokenD = await siweLogin(WALLETS.D)
check('four wallets authenticated', !!tokenA && !!tokenB && !!tokenC && !!tokenD)

console.log('── profiles')
const me = (await api('GET', '/auth/me', undefined, tokenA)) as { data: { walletAddress: string; stats: { totalPaidWei: string } } }
check('auth/me returns client A with seeded stats', me.data!.walletAddress === WALLETS.A.addr)
const profileB = (await api('GET', `/users/${WALLETS.B.addr}`)) as { data: { stats: { totalEarnedWei: string } } }
check('freelancer B derived stats visible (seeded release)', BigInt(profileB.data!.stats.totalEarnedWei) > 0n, profileB.data!.stats)

console.log('── marketplace: post job → propose → award')
const job = (await api('POST', '/jobs', {
  title: 'Smoke-test job: token gating audit',
  description: 'Review our ERC-20 gating logic across three contracts and write a findings report with severity ratings.',
  category: 'security',
  skills: ['solidity', 'audit'],
  budgetMin: '0.5', budgetMax: '1.2',
  milestones: [
    { title: 'Findings report', description: 'Initial pass with severity-ranked findings.', amount: '0.4' },
    { title: 'Follow-up review', description: 'Re-review after fixes.', amount: '0.4' },
  ],
}, tokenA)) as { status: number; data?: { id: string } }
check('job created (201)', job.status === 201, job)
const jobId = job.data!.id

const dup = (await api('POST', `/jobs/${jobId}/proposals`, { coverNote: 'x'.repeat(20), deliveryDays: 5, milestones: [{ title: 't', description: 'd', amount: '0.8' }] }, tokenA))
check('poster cannot bid on own job', dup.status === 409)

const proposal = (await api('POST', `/jobs/${jobId}/proposals`, {
  coverNote: 'Audited a dozen ERC-20 gates. Two-day turnaround, severity-ranked report included.',
  deliveryDays: 5,
  milestones: [
    { title: 'Findings report', description: 'Initial pass with severity-ranked findings.', amount: '0.4' },
    { title: 'Follow-up review', description: 'Re-review after fixes.', amount: '0.4' },
  ],
}, tokenB)) as { status: number; data?: { id: string } }
check('proposal submitted', proposal.status === 201, proposal)

const award = (await api('POST', `/proposals/${proposal.data!.id}/accept`, undefined, tokenA)) as { status: number; data?: { project: { id: string } } }
check('award created the project', award.status === 201, award)
const projectId = award.data!.project.id

const proj = (await api('GET', `/projects/${projectId}`, undefined, tokenB)) as { data: { milestones: { id: string; chainStatus: string; fund: { ref: string } }[] } }
check('two milestones pending funding', proj.data!.milestones.length === 2 && proj.data!.milestones.every((m) => m.chainStatus === 'pending_funding'))
check('milestone carries fund tx hints (ref + contract)', !!proj.data!.milestones[0]!.fund.ref)
const m1 = proj.data!.milestones[0]!
const m2 = proj.data!.milestones[1]!

console.log('── chat')
const msg = (await api('POST', `/projects/${projectId}/messages`, { body: 'Kicking off — report draft by Thursday.' }, tokenB)) as { status: number }
check('message posted', msg.status === 201)
const msgs = (await api('GET', `/projects/${projectId}/messages`, undefined, tokenA)) as { data: unknown[] }
check('client reads freelancer message', msgs.data!.length === 1)
const outsider = (await api('GET', `/projects/${projectId}/messages`, undefined, tokenC))
check('non-participant blocked from chat', outsider.status === 403)

console.log('── escrow loop (mock chain): fund → submit → approve')
const fund = (await api('POST', '/dev/chain/fund', { milestoneId: m1.id }, tokenA)) as { data: { onchainId: number } }
check('milestone 1 funded', fund.status === 201, fund)
const sub = (await api('POST', `/projects/${projectId}/milestones/${m1.id}/submissions`, { notes: 'Draft report attached in chat — findings ranked P1/P2.', attachmentIds: [] }, tokenB))
check('off-chain submission recorded', sub.status === 201)
const chainSubmit = (await api('POST', '/dev/chain/submit', { milestoneId: m1.id }, tokenB))
check('on-chain submit (state flip)', chainSubmit.status === 201)
const approve = (await api('POST', '/dev/chain/approve', { milestoneId: m1.id }, tokenA))
check('client approved (release − fee)', approve.status === 201)

const afterRelease = (await api('GET', `/projects/${projectId}`, undefined, tokenA)) as { data: { milestones: { id: string; chainStatus: string }[] } }
check('m1 mirror = released', afterRelease.data!.milestones.find((m) => m.id === m1.id)!.chainStatus === 'released')

console.log('── transaction-bound reviews')
const reviewA = (await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'Sharp findings, fast turnaround.' }, tokenA))
check('client review accepted (settlement verified)', reviewA.status === 201, reviewA)
const reviewB = (await api('POST', `/milestones/${m1.id}/reviews`, { rating: 4, body: 'Clear brief, quick approvals.' }, tokenB))
check('freelancer review accepted', reviewB.status === 201, reviewB)
const dupReview = (await api('POST', `/milestones/${m1.id}/reviews`, { rating: 1 }, tokenA))
check('duplicate review rejected', dupReview.status === 409)

console.log('── sad path: dispute → agreement → split resolution')
await api('POST', '/dev/chain/fund', { milestoneId: m2.id }, tokenA)
const dispute = (await api('POST', `/projects/${projectId}/milestones/${m2.id}/disputes`, { reason: 'Client says scope expanded beyond the milestone brief; freelancer disagrees on extra findings.' }, tokenB)) as { data?: { id: string } }
check('dispute record created with 48h window', dispute.status === 201, dispute)
await api('POST', '/dev/chain/dispute', { milestoneId: m2.id, by: WALLETS.B.addr }, tokenB)

const prop1 = (await api('POST', `/disputes/${dispute.data!.id}/arbiter-proposal`, { arbiterAddress: WALLETS.C.addr }, tokenA))
const prop2 = (await api('POST', `/disputes/${dispute.data!.id}/arbiter-proposal`, { arbiterAddress: WALLETS.C.addr }, tokenB)) as { data?: { status: string; agreedArbiter: string } }
check('mutual arbiter agreement reached', prop2.data?.status === 'agreed' && prop2.data?.agreedArbiter === WALLETS.C.addr, prop2)

const resolve = (await api('POST', '/dev/chain/resolve', { milestoneId: m2.id, arbiter: WALLETS.C.addr, outcome: 'split', withinSla: true }, tokenC))
check('arbiter resolved as split (within SLA)', resolve.status === 201, resolve)

const arb = (await api('GET', `/arbiters/${WALLETS.C.addr}`)) as { data: { trustScore: number; resolutions: number } }
check('SBT trust score incremented (+1 within SLA)', arb.data!.trustScore === 1 && arb.data!.resolutions === 1, arb.data)
const resolvedMs = (await api('GET', `/projects/${projectId}`, undefined, tokenB)) as { data: { milestones: { id: string; chainStatus: string }[]; status: string } }
check('m2 mirror = resolved_split', resolvedMs.data!.milestones.find((m) => m.id === m2.id)!.chainStatus === 'resolved_split')
check('project completed (all milestones terminal)', resolvedMs.data!.status === 'completed')

console.log('── ledger + webhook delivery')
const ledger = (await api('GET', '/ledger?limit=50')) as { data: { items: { eventType: string }[]; total: number } }
const types = ledger.data!.items.map((e) => e.eventType)
check('ledger has fund/submit/release/dispute/resolve events', ['MilestoneFunded', 'MilestoneReleased', 'DisputeOpened', 'DisputeResolved', 'MilestoneSplit'].every((t) => types.includes(t)), types)

// local webhook receiver
const { createServer } = await import('node:http')
const received: { body: string; sig: string | null }[] = []
const receiver = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    received.push({ body, sig: req.headers['x-escrowlance-signature'] ?? null })
    res.writeHead(200).end('ok')
  })
})
await new Promise<void>((r) => receiver.listen(4545, r))
const hook = (await api('POST', '/webhooks', { url: 'http://localhost:4545/hook', eventTypes: [] }, tokenA)) as { data?: { id: string; secret: string } }
check('webhook subscription created', hook.status === 201, hook)

// trigger an event: a review on m2 by A (after split resolution both sides may review)
const review2 = (await api('POST', `/milestones/${m2.id}/reviews`, { rating: 3, body: 'Split was fair.' }, tokenA))
check('post-resolution review accepted', review2.status === 201, review2)

await new Promise((r) => setTimeout(r, 1500))
check('webhook delivered with HMAC signature', received.length >= 1 && !!received[0]!.sig?.startsWith('sha256='), received.length)
const deliveries = (await api('GET', `/webhooks/${hook.data!.id}/deliveries`, undefined, tokenA)) as { data: { status: string }[] }
check('delivery log shows success', deliveries.data!.some((d) => d.status === 'success'), deliveries.data)

receiver.close()

console.log('── access control spot checks')
const noAuth = (await api('POST', '/jobs', { title: 'x'.repeat(4), description: 'y'.repeat(20), category: 'c', budgetMin: '1', budgetMax: '2', milestones: [{ title: 't', description: 'd', amount: '1' }] }))
check('unauthenticated job post rejected', noAuth.status === 401)
const wrongUser = (await api('POST', `/proposals/${proposal.data!.id}/accept`, undefined, tokenB))
check('non-poster cannot award', wrongUser.status === 403)
const adminRoute = (await api('POST', '/admin/reconcile', undefined, tokenA))
check('non-admin blocked from admin route (no ADMIN_WALLETS configured → nobody passes)', adminRoute.status === 403 || adminRoute.status === 401)

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED ✓' : `\n${failures} SMOKE CHECKS FAILED ✗`)
process.exit(failures === 0 ? 0 : 1)
