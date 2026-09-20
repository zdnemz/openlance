/**
 * E2E: the full golden path against a REAL EVM — anvil running the actual
 * Foundry contracts (contracts/Escrow.sol + ArbiterRegistry.sol), the API in
 * CHAIN_MODE=real, and the real viem indexer.
 *
 * This is the proof that the adapter seam was honest: every /dev/chain call in
 * scripts/smoke.ts is replaced by a wallet transaction, and the indexer, mirror,
 * stats, RPC-verified reviews and webhooks all behave identically.
 *
 * Prereqs (see contracts/README.md → "Anvil end-to-end"):
 *   1. anvil --block-time 1 --chain-id 31337          # background
 *   2. forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
 *        --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
  *   3. API on :3031 with CHAIN_MODE=real CHAIN_ID=31337 DATABASE_URL=postgresql://.../openlance
  *      (fresh env DB — db:migrate first), ESCROW_ADDRESS / ARBITER_REGISTRY_ADDRESS set,
 *      INDEXER_CONFIRMATIONS=1 INDEXER_POLL_MS=1500.
 *
 * Run: bun scripts/e2e-anvil.ts
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { anvil } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const API = process.env.E2E_API ?? 'http://localhost:3000/api'
const RPC = process.env.E2E_RPC ?? 'http://127.0.0.1:8545'
const ESCROW = (process.env.ESCROW_ADDRESS ?? '').toLowerCase() as `0x${string}`
const REGISTRY = (process.env.ARBITER_REGISTRY_ADDRESS ?? '').toLowerCase() as `0x${string}`
if (!/^0x[0-9a-f]{40}$/.test(ESCROW) || !/^0x[0-9a-f]{40}$/.test(REGISTRY)) {
  console.error('ESCROW_ADDRESS / ARBITER_REGISTRY_ADDRESS env vars required (deployed contracts)')
  process.exit(1)
}

const CHAIN_ID = 31337
const DOMAIN = 'localhost:3000'

// anvil deterministic accounts: #0 client (also deployer/admin), #1 freelancer, #5 arbiter
const A = { key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', addr: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' }
const B = { key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', addr: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }
const C = { key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', addr: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc' }

const ESCROW_FN = parseAbi([
  'function fund(bytes32 ref, address freelancer) payable',
  'function submit(uint256 milestoneId)',
  'function approve(uint256 milestoneId)',
  'function openDispute(uint256 milestoneId)',
  'function nominateArbiter(uint256 milestoneId, address candidate)',
  'function resolveDispute(uint256 milestoneId, uint8 outcome)',
  'function withdrawFees(address to)',
  'function accruedFees() view returns (uint256)',
  'function milestoneStatus(uint256 milestoneId) view returns (uint8)',
])
const REGISTRY_FN = parseAbi(['function register(address arbiter)'])

const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (key: string) => createWalletClient({
  account: privateKeyToAccount(key as `0x${string}`),
  chain: anvil,
  transport: http(RPC),
})

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}`, extra ?? '') }
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
  const account = privateKeyToAccount(w.key as `0x${string}`)
  const { data: nonceData } = (await api('GET', '/auth/nonce')) as { data: { nonce: string } }
  const message = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    'Sign in to OpenLance - milestone escrow for freelance work.',
    '',
    'URI: http://localhost:3000',
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonceData!.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n')
  const signature = await account.signMessage({ message })
  const res = (await api('POST', '/auth/verify', { message, signature })) as { status: number; data?: { token: string } }
  if ((res.status !== 200 && res.status !== 201) || !res.data) throw new Error(`login failed: ${JSON.stringify(res)}`)
  return res.data.token
}

// Walk the real onboarding path: writes (jobs, proposals, profile, …) require
// verified KYC, so the e2e wallets verify exactly like users do.
async function onboard(token: string, name: string, role: 'client' | 'freelancer' | 'arbiter') {
  const r = await api('POST', '/users/me/role', { role }, token)
  if (r.status !== 200 || !r.data) throw new Error(`role failed: ${JSON.stringify(r)}`)
  const sub = (await api('POST', '/users/me/kyc', {
    fullName: name, country: 'E2E', idType: 'passport', idNumber: 'E2E-0001', livenessConfirmed: true,
  }, token)) as { status: number; data?: { user: { kycStatus: string } } }
  if (sub.status !== 200 || !sub.data) throw new Error(`kyc failed: ${JSON.stringify(sub)}`)
  if (sub.data.user.kycStatus === 'pending') {
    const ap = await api('POST', '/users/me/kyc?action=approve', {}, token)
    if (ap.status !== 200) throw new Error(`approve failed: ${JSON.stringify(ap)}`)
  }
}

type Mirror = { milestones: { id: string; chainStatus: string; onchainId: number | null; fund: { ref: string; amountWei: string } }[]; status: string }
async function projectView(id: string, token: string) {
  return (await api('GET', `/projects/${id}`, undefined, token)) as { data: Mirror }
}

/** Poll the API mirror until the indexer has applied the expected chain state. */
async function waitForMirror(label: string, projectId: string, token: string, pred: (p: Mirror) => boolean, timeoutMs = 25_000) {
  const started = Date.now()
  for (;;) {
    const { data } = await projectView(projectId, token)
    if (data && pred(data)) return data
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 800))
  }
}

console.log('── sanity: anvil chain + contracts')
check('chain id is 31337', Number(await publicClient.getChainId()) === 31337)

console.log('── SIWE login (chain 31337)')
const tokenA = await siweLogin(A)
const tokenB = await siweLogin(B)
const tokenC = await siweLogin(C)
check('three wallets authenticated', !!tokenA && !!tokenB && !!tokenC)
await onboard(tokenA, 'E2E Client', 'client')
await onboard(tokenB, 'E2E Freelancer', 'freelancer')

console.log('── marketplace: job → proposal → award (off-chain)')
const job = (await api('POST', '/jobs', {
  title: 'E2E anvil job: escrow integration proof',
  description: 'Fund, submit, approve and dispute against the real Foundry contracts on anvil.',
  category: 'backend',
  skills: ['solidity', 'foundry'],
  budgetMin: '0.02', budgetMax: '0.04',
  milestones: [
    { title: 'Happy path', description: 'fund → submit → approve, with reviews.', amount: '0.02' },
    { title: 'Dispute path', description: 'fund → dispute → mutual nomination → split.', amount: '0.01' },
  ],
}, tokenA)) as { status: number; data?: { id: string } }
check('job created', job.status === 201, job)

const proposal = (await api('POST', `/jobs/${job.data!.id}/proposals`, {
  coverNote: 'Real-chain e2e proposal — deterministic anvil wallets, no funds at risk.',
  deliveryDays: 1,
  milestones: [
    { title: 'Happy path', description: 'fund → submit → approve, with reviews.', amount: '0.02' },
    { title: 'Dispute path', description: 'fund → dispute → mutual nomination → split.', amount: '0.01' },
  ],
}, tokenB)) as { status: number; data?: { id: string } }
check('proposal submitted', proposal.status === 201, proposal)

const award = (await api('POST', `/proposals/${proposal.data!.id}/accept`, undefined, tokenA)) as { status: number; data?: { project: { id: string } } }
check('award created the project', award.status === 201, award)
const projectId = award.data!.project.id

const initial = await projectView(projectId, tokenA)
check('two milestones pending funding', initial.data!.milestones.length === 2 && initial.data!.milestones.every((m) => m.chainStatus === 'pending_funding'))
const m1 = initial.data!.milestones[0]!
const m2 = initial.data!.milestones[1]!
check('milestones carry fund tx hints (ref + amountWei for the wallet)', !!m1.fund.ref && BigInt(m1.fund.amountWei) === 2_000_000_000_000_000_0n)

console.log('── register arbiter on-chain (registry.register by deployer)')
{
  const hash = await wallet(A.key).writeContract({ address: REGISTRY, abi: REGISTRY_FN, functionName: 'register', args: [C.addr], account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash })
  check('registry.register mined', true)
}

console.log('── happy path on the REAL chain: fund → submit → approve')
{
  const balB0 = await publicClient.getBalance({ address: B.addr })

  const fundHash = await wallet(A.key).writeContract({
    address: ESCROW, abi: ESCROW_FN, functionName: 'fund',
    args: [m1.fund.ref as `0x${string}`, B.addr], value: BigInt(m1.fund.amountWei),
    account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil,
  })
  await publicClient.waitForTransactionReceipt({ hash: fundHash })

  const funded = await waitForMirror('m1 funded', projectId, tokenA, (p) => p.milestones[0]!.chainStatus === 'funded')
  const onchain1 = funded.milestones[0]!.onchainId!
  check('indexer mirrored MilestoneFunded (ref join worked)', onchain1 === 1, `onchainId=${onchain1}`)

  const sub = await api('POST', `/projects/${projectId}/milestones/${m1.id}/submissions`, { notes: 'Report draft attached — findings ranked.', attachmentIds: [] }, tokenB)
  check('off-chain submission recorded', sub.status === 201, sub)

  const submitHash = await wallet(B.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'submit', args: [BigInt(onchain1)], account: privateKeyToAccount(B.key as `0x${string}`), chain: anvil })
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash })
  await waitForMirror('m1 submitted', projectId, tokenA, (p) => p.milestones[0]!.chainStatus === 'submitted')
  check('indexer mirrored MilestoneSubmitted', true)

  const approveHash = await wallet(A.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'approve', args: [BigInt(onchain1)], account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash: approveHash })
  await waitForMirror('m1 released', projectId, tokenA, (p) => p.milestones[0]!.chainStatus === 'released')
  check('indexer mirrored MilestoneReleased (project completion detection ran)', true)

  // Money math straight from the chain (gas B paid for its own submit tx excluded)
  const amount = BigInt(m1.fund.amountWei)
  const fee = amount * 250n / 10_000n
  const balB1 = await publicClient.getBalance({ address: B.addr })
  const submitGas = submitReceipt.gasUsed * (submitReceipt.effectiveGasPrice ?? submitReceipt.gasPrice ?? 0n)
  const accrued = await publicClient.readContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'accruedFees' })
  check('freelancer paid principal (2.5% fee withheld, gas excluded)', balB1 - balB0 + submitGas === amount - fee, { delta: (balB1 - balB0).toString(), gas: submitGas.toString() })
  check('contract accruedFees == fee', accrued === fee, accrued.toString())

  // Transaction-bound reviews — the RPC re-verification path (readContract milestoneStatus)
  const reviewA = await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'Real-chain release, verified via RPC.' }, tokenA)
  check('client review accepted (mirror + RPC settlement check)', reviewA.status === 201, reviewA)
  const reviewB = await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'Prompt approval on-chain.' }, tokenB)
  check('freelancer review accepted', reviewB.status === 201, reviewB)
}

console.log('── dispute path on the REAL chain: fund → dispute → mutual nomination → split')
{
  const fundHash = await wallet(A.key).writeContract({
    address: ESCROW, abi: ESCROW_FN, functionName: 'fund',
    args: [m2.fund.ref as `0x${string}`, B.addr], value: BigInt(m2.fund.amountWei),
    account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil,
  })
  await publicClient.waitForTransactionReceipt({ hash: fundHash })
  const funded = await waitForMirror('m2 funded', projectId, tokenB, (p) => p.milestones[1]!.chainStatus === 'funded')
  const onchain2 = funded.milestones[1]!.onchainId!

  // Off-chain dispute record FIRST (reason + coordination), then the on-chain lock
  const dispute = await api('POST', `/projects/${projectId}/milestones/${m2.id}/disputes`, { reason: 'Scope disagreement: client expected the follow-up review inside this milestone.' }, tokenB)
  check('off-chain dispute record created', dispute.status === 201, dispute)

  const openHash = await wallet(B.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'openDispute', args: [BigInt(onchain2)], account: privateKeyToAccount(B.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash: openHash })
  await waitForMirror('m2 disputed', projectId, tokenB, (p) => p.milestones[1]!.chainStatus === 'disputed')
  check('indexer mirrored DisputeOpened', true)

  // Mutual nomination — the trust-minimized path, both parties on-chain
  const nomA = await wallet(A.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'nominateArbiter', args: [BigInt(onchain2), C.addr], account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash: nomA })
  const nomB = await wallet(B.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'nominateArbiter', args: [BigInt(onchain2), C.addr], account: privateKeyToAccount(B.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash: nomB })
  check('mutual nomination assigned the arbiter (SLA clock started)', true)

  const resolveHash = await wallet(C.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'resolveDispute', args: [BigInt(onchain2), 2 /* split */], account: privateKeyToAccount(C.key as `0x${string}`), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash: resolveHash })
  const settled = await waitForMirror('m2 resolved_split', projectId, tokenB, (p) => p.milestones[1]!.chainStatus === 'resolved_split')
  check('indexer mirrored DisputeResolved → MilestoneSplit (event order respected)', true)
  check('project completed (all milestones terminal)', settled.status === 'completed')

  // Trust score lives on the REGISTRY contract — proves dual-address log polling
  const arb = (await api('GET', `/arbiters/${C.addr}`)) as { data: { trustScore: number; resolutions: number; registered: boolean } }
  check('arbiter SBT trust score +1 (registry events indexed)', arb.data?.trustScore === 1 && arb.data?.resolutions === 1, arb.data)

  // Solvency, checked against the chain itself: nothing unsettled → balance == accrued fees
  const balance = await publicClient.getBalance({ address: ESCROW })
  const accrued = await publicClient.readContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'accruedFees' })
  check('solvency invariant live: escrow balance == accrued fees (all settled)', balance === accrued, { balance: balance.toString(), accrued: accrued.toString() })

  // Fee exit: owner withdraws, ledger records FeeWithdrawn from the real tx
  const wdHash = await wallet(A.key).writeContract({ address: ESCROW, abi: ESCROW_FN, functionName: 'withdrawFees', args: [A.addr], account: privateKeyToAccount(A.key as `0x${string}`), chain: anvil })
  const wdReceipt = await publicClient.waitForTransactionReceipt({ hash: wdHash })
  await new Promise((r) => setTimeout(r, 2500))
  const ledger = (await api('GET', '/ledger?limit=50')) as { data: { items: { eventType: string; txHash: string }[] } }
  const types = ledger.data!.items.map((e) => e.eventType)
  check('ledger covers the full event surface', ['MilestoneFunded', 'MilestoneSubmitted', 'MilestoneReleased', 'DisputeOpened', 'DisputeResolved', 'MilestoneSplit', 'TrustScoreUpdated', 'ArbiterRegistered', 'FeeWithdrawn'].every((t) => types.includes(t)), types)
  check('ledger rows carry real tx hashes', ledger.data!.items.every((e) => /^0x[0-9a-f]{64}$/.test(e.txHash)))
  check('FeeWithdrawn row matches the withdraw tx', ledger.data!.items.some((e) => e.eventType === 'FeeWithdrawn' && e.txHash === wdReceipt.transactionHash))
  const after = await publicClient.getBalance({ address: ESCROW })
  check('escrow balance zero after fee withdrawal', after === 0n, after.toString())
}

console.log('── reconciliation (real mode)')
const recon = await api('POST', '/admin/reconcile', undefined, tokenA)
check('reconciliation ran (admin wallet = deployer)', recon.status === 200 || recon.status === 201, recon)
const reconList = (await api('GET', '/admin/reconciliations', undefined, tokenA)) as { data?: { drifts: number; report?: { solvency?: { ok: boolean; balanceWei: string; liabilitiesWei: string } } }[] }
const last = reconList.data?.[0]
check('reconciliation found zero drift', last?.drifts === 0, last)
check('solvency report present and ok (balance ≥ liabilities)', last?.report?.solvency?.ok === true, last?.report?.solvency)

console.log(failures === 0 ? '\nALL ANVIL E2E CHECKS PASSED ✓ — the contracts, indexer, mirror and RPC gates agree.' : `\n${failures} ANVIL E2E CHECKS FAILED ✗`)
process.exit(failures === 0 ? 0 : 1)
