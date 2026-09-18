/**
 * Rich demo seed for the anvil (real-chain) stack.
 *
 * Runs AFTER the API is healthy (scripts/dev-real.sh). Creates personas,
 * 3 open jobs, proposals, and 3 projects in deliberately different states:
 *
 *   Project A "in progress"  — m1 released + reviewed, m2 funded (freelancer
 *                              can submit from the UI)
 *   Project B "disputed"     — m1 submitted then disputed; arbiter proposals
 *                              open — the user drives nomination + resolution
 *   Project C "completed"    — full lifecycle incl. mutual nomination, split
 *                              resolution, both-side reviews; arbiter score +1
 *
 * All money movement is REAL: fund/submit/approve/openDispute/nominate/
 * resolve transactions signed by anvil personas against the deployed
 * contracts, mirrored by the real indexer.
 *
 * Idempotent: exits early if the DB already has users.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { anvil } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const API = process.env.SEED_API ?? 'http://localhost:3030'
const RPC = process.env.SEED_RPC ?? 'http://127.0.0.1:8545'
const deployment = JSON.parse(readFileSync(resolve(here, '../.anvil-deployment.json'), 'utf8')) as {
  escrow: `0x${string}`; arbiterRegistry: `0x${string}`
}
const ESCROW = deployment.escrow
const REGISTRY = deployment.arbiterRegistry

// ── Personas (anvil deterministic accounts — public test keys) ──────────────
const P = {
  mara:   { key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', addr: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', name: 'Mara Voss' },
  dario:  { key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', addr: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', name: 'Dario Kessler' },
  junko:  { key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', addr: '0x3c44cddddb6a900fa2b585dd299e03d12fa4293bc', name: 'Junko Almeida' },
  rhys:   { key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', addr: '0x90f79bf6eb2c4f870365e785982e1f101e93b906', name: 'Rhys Okafor' },
  ingrid: { key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', addr: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', name: 'Ingrid Salm' },
}

const ESCROW_FN = parseAbi([
  'function fund(bytes32 ref, address freelancer) payable',
  'function submit(uint256 milestoneId)',
  'function approve(uint256 milestoneId)',
  'function openDispute(uint256 milestoneId)',
  'function nominateArbiter(uint256 milestoneId, address candidate)',
  'function resolveDispute(uint256 milestoneId, uint8 outcome)',
  'function withdrawFees(address to)',
])
const REGISTRY_FN = parseAbi(['function register(address arbiter)'])

const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (key: string) => createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain: anvil, transport: http(RPC) })
const acct = (key: string) => privateKeyToAccount(key as `0x${string}`)
const tx = async (key: string, call: Parameters<ReturnType<typeof wallet>['writeContract']>[0]) => {
  const hash = await wallet(key).writeContract({ ...call, account: acct(key), chain: anvil })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { data?: any; error?: { message: string } }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${json.error?.message ?? 'unknown'}`)
  return json.data
}

async function siweLogin(p: { key: string; addr: string }) {
  const account = acct(p.key)
  const nonceData = await api('GET', '/auth/nonce')
  const message = [
    `localhost:3000 wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    'Sign in to EscrowLance - milestone escrow for freelance work.',
    '',
    'URI: http://localhost:3000',
    'Version: 1',
    'Chain ID: 31337',
    `Nonce: ${nonceData.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n')
  const signature = await account.signMessage({ message })
  const res = await api('POST', '/auth/verify', { message, signature })
  return res.token as string
}

type Mirror = { milestones: { id: string; chainStatus: string; onchainId: number | null; fund: { ref: string; amountWei: string } }[]; status: string }
async function mirrorWait(label: string, projectId: string, token: string, pred: (p: Mirror) => boolean, timeoutMs = 40_000) {
  const started = Date.now()
  for (;;) {
    const p = (await api('GET', `/projects/${projectId}`, undefined, token)) as Mirror
    if (p && pred(p)) return p
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 900))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string) => console.log(`[seed] ${msg}`)

// ── Seed ─────────────────────────────────────────────────────────────────────
async function main() {
  const overview = await api('GET', '/overview')
  if (overview.counts.users > 0) { log('already seeded — skipping'); return }

  log('logging in personas')
  const t = {
    mara: await siweLogin(P.mara), dario: await siweLogin(P.dario), junko: await siweLogin(P.junko),
    rhys: await siweLogin(P.rhys), ingrid: await siweLogin(P.ingrid),
  }

  log('writing profiles')
  await api('PATCH', '/users/me', {
    displayName: 'Mara Voss', role: 'client', bio: 'Founder at Studio Halo — a five-person product studio shipping web3 tooling. I hire for audit-grade work and pay through escrow, milestone by milestone.',
    skills: ['product', 'web3', 'studio-ops'], links: { studio: 'https://studiohalo.example' },
  }, t.mara)
  await api('PATCH', '/users/me', {
    displayName: 'Dario Kessler', role: 'freelancer', bio: 'Protocol engineer. Foundry native: fuzz suites, invariant testing, gas golfing. Ex-bridge team, now independent. I quote in milestones because that is how work actually ships.',
    skills: ['solidity', 'foundry', 'fuzzing', 'security', 'vyper'],
  }, t.dario)
  await api('PATCH', '/users/me', {
    displayName: 'Junko Almeida', role: 'both', bio: 'Full-stack dev (Next.js/Rust). I build trading dashboards and post the occasional contracts job when my queue clears.',
    skills: ['nextjs', 'react', 'rust', 'websockets', 'typescript'],
  }, t.junko)
  await api('PATCH', '/users/me', {
    displayName: 'Rhys Okafor', role: 'freelancer', bio: 'Front-end engineer with a designsystems background. Realtime UIs, canvas work, motion that earns its frame cost.',
    skills: ['react', 'nextjs', 'canvas', 'websockets', 'tailwind'],
  }, t.rhys)
  await api('PATCH', '/users/me', {
    displayName: 'Ingrid Salm', role: 'freelancer', bio: 'Security researcher and EscrowLance arbiter. 40+ peer reviews, MEV-adjacent by day. I resolve disputes on the evidence, not the vibes.',
    skills: ['security', 'auditing', 'solidity'],
  }, t.ingrid)

  log('registering arbiter on-chain (Ingrid)')
  await tx(P.mara.key, { address: REGISTRY, abi: REGISTRY_FN, functionName: 'register', args: [P.ingrid.addr] })

  // ── Jobs ─────────────────────────────────────────────────────────────────
  log('posting jobs')
  const auditJob = await api('POST', '/jobs', {
    title: 'Invariant fuzz audit for a cross-chain bridge (Foundry)',
    description: [
      'We run a modest bridge (Optimism-stack L2 to Base) moving about 3.1M/month. Last audit is 14 months old and we have since added a message-passing layer.',
      'Scope: (1) threat model refresh against the new message layer, (2) an invariant + fuzz suite in Foundry covering the escrow path, fee accounting, and upgrade guardians, (3) a written report with severity-ranked findings and a retest pass on our fixes.',
      'You get escrowed milestones, review windows, and a dispute path you will hopefully never need. Gas is on us; we fund a burner for your fork tests.',
    ].join('\n\n'),
    category: 'security',
    skills: ['solidity', 'foundry', 'fuzzing'],
    budgetMin: '0.42', budgetMax: '0.85',
    milestones: [
      { title: 'Threat model + attack surface map', description: 'Refresh the threat model for the message-passing layer. Deliver a ranked attack-surface map we can both sign off on.', amount: '0.24' },
      { title: 'Invariant + fuzz suite', description: 'Foundry suite: stateful invariants on the escrow path, property tests on fee accounting, fuzz handlers for guardian rotation.', amount: '0.38' },
      { title: 'Report, fix review, retest', description: 'Severity-ranked report, review our patches, retest, and a 30-min walkthrough call with the team.', amount: '0.17' },
    ],
  }, t.mara)

  const dashJob = await api('POST', '/jobs', {
    title: 'Realtime market dashboard — Next.js over a WebSocket feed',
    description: [
      'Trading dashboard for a niche market (prediction-market odds, not CEX candles). Feed server emits ~120 events/sec.',
      'Need: a Next.js app with a live orderbook-style grid, position cards, and a chart that stays at 60fps under load. Data layer must degrade gracefully when the socket drops. Design system exists in Figma; you will not be inventing visual design, just executing it precisely.',
      'Milestone 1 is the feed layer + reconnection story. Milestone 2 is the UI. We test on a throttled CPU profile before sign-off.',
    ].join('\n\n'),
    category: 'frontend',
    skills: ['nextjs', 'react', 'websockets', 'typescript'],
    budgetMin: '0.16', budgetMax: '0.31',
    milestones: [
      { title: 'Feed layer + reconnect', description: 'WebSocket client, event batching, gap detection, replay on reconnect. Tested against a chaos proxy.', amount: '0.11' },
      { title: 'Dashboard UI', description: 'Grid, position cards, chart. 60fps on a 4x CPU throttle, zero layout thrash.', amount: '0.14' },
    ],
  }, t.mara)

  const nftJob = await api('POST', '/jobs', {
    title: 'Gas-tight ERC-721A drop contract with merkle allowlist',
    description: [
      'Small drop: 4,444 pieces, two phases (allowlist then public), 5 mints per wallet, 90-minute phase gap enforced on-chain.',
      'Requirements: ERC-721A or equivalent batch-mint economics, merkle-root allowlist with per-wallet caps, reveal via provenance hash, and a withdrawal path that splits proceeds 82/18 to two addresses. Test coverage matters more than comments.',
      'I review with Foundry; if your invariants are lazy I will ask for a redo before approval.',
    ].join('\n\n'),
    category: 'contracts',
    skills: ['solidity', 'erc721a', 'merkle', 'foundry'],
    budgetMin: '0.19', budgetMax: '0.41',
    milestones: [
      { title: 'Contract + invariant tests', description: 'Drop contract, phase logic, allowlist, reveal, split withdrawal. Invariant suite for supply + caps.', amount: '0.16' },
      { title: 'Deployment scripts + dry-run', description: 'Deploy script against a fork, simulation artifacts, handover notes.', amount: '0.09' },
    ],
  }, t.junko)

  log('submitting proposals')
  const darioAudit = await api('POST', `/jobs/${auditJob.id}/proposals`, {
    coverNote: 'Bridges are exactly my lane — I spent two years inside one. Plan: day one I map the message layer and hand you the threat model; week two is the invariant suite (I will show you the handler architecture first, no black box); report lands with a retest. I quote the middle milestone heaviest because that is where the risk lives. Happy to walk through a prior bridge audit on a call.',
    deliveryDays: 21,
    milestones: [
      { title: 'Threat model + attack surface map', description: 'Ranked attack-surface map for the message-passing layer, signed off by both sides before fuzzing starts.', amount: '0.24' },
      { title: 'Invariant + fuzz suite', description: 'Stateful invariants on the escrow path, property tests on fee accounting, fuzz handlers for guardian rotation — handed over as a Foundry suite you can run in CI.', amount: '0.38' },
      { title: 'Report, fix review, retest', description: 'Severity-ranked findings, patch review, retest pass, recorded walkthrough.', amount: '0.17' },
    ],
  }, t.dario)

  const junkoAudit = await api('POST', `/jobs/${auditJob.id}/proposals`, {
    coverNote: 'Strong Foundry background (mostly protocol-side, some audit work on smaller bridges). I would start with the fee accounting invariants — that is where the last two bridge incidents I studied lived. 28-day timeline, working overlap with your timezone.',
    deliveryDays: 28,
    milestones: [
      { title: 'Threat model', description: 'Threat model + attack-surface map for the message layer.', amount: '0.22' },
      { title: 'Fuzz suite', description: 'Invariant and fuzz coverage on the escrow path and guardians.', amount: '0.36' },
      { title: 'Report + retest', description: 'Findings report, fix review, retest.', amount: '0.19' },
    ],
  }, t.junko)

  const rhysDash = await api('POST', `/jobs/${dashJob.id}/proposals`, {
    coverNote: 'Realtime grids are my favorite kind of problem. Last dashboard held 60fps at ~200 events/sec on a throttled CPU — happy to demo it. I would build the feed layer with an explicit replay buffer so reconnects are boring. Figma execution only, as specified.',
    deliveryDays: 14,
    milestones: [
      { title: 'Feed layer + reconnect', description: 'WS client, batching, gap detection, replay. Chaos-proxy tested.', amount: '0.11' },
      { title: 'Dashboard UI', description: 'Orderbook grid, position cards, chart — 60fps under 4x throttle.', amount: '0.14' },
    ],
  }, t.rhys)

  const darioDash = await api('POST', `/jobs/${dashJob.id}/proposals`, {
    coverNote: 'I can take the feed-layer milestone solo if you want to split the work: my Rust/WS layer under your UI of choice. Milestone 1 quoted below; UI milestone optional.',
    deliveryDays: 10,
    milestones: [
      { title: 'Feed layer + reconnect', description: 'Rust-backed WS bridge, batching, replay on reconnect.', amount: '0.10' },
    ],
  }, t.dario)

  const rhysNft = await api('POST', `/jobs/${nftJob.id}/proposals`, {
    coverNote: 'Not my core lane, but I have shipped two drop UIs and can handle the contract if you want one vendor. Prefer to stay on UI work though — quoting only as a fallback option.',
    deliveryDays: 18,
    milestones: [
      { title: 'Contract + tests', description: '721A drop, phases, allowlist, reveal, split withdrawal.', amount: '0.17' },
      { title: 'Deploy scripts', description: 'Fork dry-run, deployment artifacts, handover.', amount: '0.08' },
    ],
  }, t.rhys)

  const darioNft = await api('POST', `/jobs/${nftJob.id}/proposals`, {
    coverNote: 'Drop contracts are a well-trodden path for me: 721A economics, two-phase merkle allowlist with per-wallet caps, provenance reveal, 82/18 split withdrawal — all covered by invariants (supply, caps, phase timing). You review with Foundry, I welcome it.',
    deliveryDays: 12,
    milestones: [
      { title: 'Contract + invariant tests', description: 'Full drop contract; invariant suite over supply, caps, phase gaps, withdrawal split.', amount: '0.16' },
      { title: 'Deployment scripts + dry-run', description: 'Fork deploy, simulation artifacts, handover notes.', amount: '0.09' },
    ],
  }, t.dario)

  // ── Project A: audit, Dario — m1 released+reviewed, m2 funded ────────────
  log('project A: award audit job to Dario')
  const awardA = await api('POST', `/proposals/${darioAudit.id}/accept`, undefined, t.mara)
  const projA = awardA.project.id
  {
    let view = await mirrorWait('A initial', projA, t.mara, (p) => p.milestones.length === 3)
    const m1 = view.milestones[0]!, m2 = view.milestones[1]!

    log('project A: fund m1')
    await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'fund', args: [m1.fund.ref as `0x${string}`, P.dario.addr], value: BigInt(m1.fund.amountWei) })
    view = await mirrorWait('A m1 funded', projA, t.mara, (p) => p.milestones[0]!.chainStatus === 'funded')

    await api('POST', `/projects/${projA}/milestones/${m1.id}/submissions`, {
      notes: 'Threat model + attack-surface map attached as a repo (docs/threat-model.md). Ranked 14 surfaces; three are marked red and drive the fuzz-suite priorities. Two of the red ones are in the message-passing layer, as suspected.',
    }, t.dario)
    await tx(P.dario.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'submit', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('A m1 submitted', projA, t.mara, (p) => p.milestones[0]!.chainStatus === 'submitted')

    log('project A: approve + release m1')
    await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'approve', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('A m1 released', projA, t.mara, (p) => p.milestones[0]!.chainStatus === 'released')

    await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'The threat model reframed how we see the message layer. Red-ranked surfaces were exactly where the fuzz suite found issues later. This is the standard.' }, t.mara)
    await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'Fast sign-off, sharp questions on the call, escrow released on approval. The way work should be paid.' }, t.dario)

    log('project A: fund m2 (leaves it funded — freelancer submits from the UI)')
    await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'fund', args: [m2.fund.ref as `0x${string}`, P.dario.addr], value: BigInt(m2.fund.amountWei) })
    await mirrorWait('A m2 funded', projA, t.mara, (p) => p.milestones[1]!.chainStatus === 'funded')

    await api('POST', `/projects/${projA}/messages`, { body: 'M1 payment landed — clean. I am starting the invariant suite now, beginning with the escrow path. Expect a first handler sketch in ~2 days.' }, t.dario)
    await api('POST', `/projects/${projA}/messages`, { body: 'Great. One request: keep the ghost-accounting pattern from your last audit writeup, our engineers found it the easiest to review.' }, t.mara)
    await api('POST', `/projects/${projA}/messages`, { body: 'Already the plan — same structure, plus a diff report when guardians rotate mid-sequence.' }, t.dario)
  }

  // ── Project B: dashboard, Rhys — m1 submitted then DISPUTED ──────────────
  log('project B: award dashboard job to Rhys')
  const awardB = await api('POST', `/proposals/${rhysDash.id}/accept`, undefined, t.mara)
  const projB = awardB.project.id
  {
    let view = await mirrorWait('B initial', projB, t.mara, (p) => p.milestones.length === 2)
    const m1 = view.milestones[0]!

    log('project B: fund + submit m1')
    await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'fund', args: [m1.fund.ref as `0x${string}`, P.rhys.addr], value: BigInt(m1.fund.amountWei) })
    view = await mirrorWait('B m1 funded', projB, t.mara, (p) => p.milestones[0]!.chainStatus === 'funded')

    await api('POST', `/projects/${projB}/milestones/${m1.id}/submissions`, {
      notes: 'Feed layer delivered: WS client with 120 ev/s sustained, batched renders, gap detection with sequence numbers, replay buffer. Chaos-proxy report included (3.2% packet loss, 2 reconnect storms). One caveat: I added a metrics tap you did not ask for — it cost ~4 hours and I did not charge for it, but it makes the reconnection story visible in the devtools.',
    }, t.rhys)
    await tx(P.rhys.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'submit', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('B m1 submitted', projB, t.mara, (p) => p.milestones[0]!.chainStatus === 'submitted')

    log('project B: client disputes m1')
    await api('POST', `/projects/${projB}/milestones/${m1.id}/disputes`, {
      reason: 'Scope disagreement. The feed layer works, but the spec said the reconnect replay must be seamless — under the chaos proxy there is a visible 800ms stall while the buffer replays. I read "graceful degradation" as no visible stall; Rhys reads it as no data loss. We could not close this in chat, so locking it with an arbiter per the contract. (Also: the metrics tap is excellent and I want to keep it — that part is not in dispute.)',
    }, t.mara)
    await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'openDispute', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('B m1 disputed', projB, t.mara, (p) => p.milestones[0]!.chainStatus === 'disputed')

    await api('POST', `/projects/${projB}/messages`, { body: 'Opened a dispute on m1 — nothing personal, the replay stall is a spec gap and I want an arbiter reading of "graceful". Everything else you shipped is above bar.' }, t.mara)
    await api('POST', `/projects/${projB}/messages`, { body: 'Understood, and honestly the right call — we read the same sentence two ways. I will nominate Ingrid Salm as arbiter; she has shipped WS-heavy UIs and will get the 800ms question immediately.' }, t.rhys)
  }

  // ── Project C: NFT drop, Dario — full lifecycle, split resolution ────────
  log('project C: award NFT job to Dario')
  const awardC = await api('POST', `/proposals/${darioNft.id}/accept`, undefined, t.junko)
  const projC = awardC.project.id
  {
    let view = await mirrorWait('C initial', projC, t.junko, (p) => p.milestones.length === 2)
    const m1 = view.milestones[0]!, m2 = view.milestones[1]!

    log('project C: m1 fund → submit → approve → reviews')
    await tx(P.junko.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'fund', args: [m1.fund.ref as `0x${string}`, P.dario.addr], value: BigInt(m1.fund.amountWei) })
    view = await mirrorWait('C m1 funded', projC, t.junko, (p) => p.milestones[0]!.chainStatus === 'funded')

    await api('POST', `/projects/${projC}/milestones/${m1.id}/submissions`, {
      notes: 'Contract + invariant suite delivered. 31 tests: supply conservation, per-wallet caps across phases, phase-gap timing (90m enforced on-chain, tested with warp), reveal provenance, 82/18 split with odd-wei rounding to the major payee. Coverage on the drop path: 100% lines / 97% branches.',
    }, t.dario)
    await tx(P.dario.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'submit', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('C m1 submitted', projC, t.junko, (p) => p.milestones[0]!.chainStatus === 'submitted')

    await tx(P.junko.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'approve', args: [BigInt(view.milestones[0]!.onchainId!)] })
    await mirrorWait('C m1 released', projC, t.junko, (p) => p.milestones[0]!.chainStatus === 'released')
    await api('POST', `/milestones/${m1.id}/reviews`, { rating: 5, body: 'Invariants were not lazy — the warp-based phase-gap tests alone were worth the milestone. Approved without a single redo.' }, t.junko)
    await api('POST', `/milestones/${m1.id}/reviews`, { rating: 4, body: 'Clear brief, fast reviews, one scope question answered within hours. Docked a star only because the fork RPC you provided was flaky.' }, t.dario)

    log('project C: m2 fund → submit → dispute → mutual nomination → split')
    await tx(P.junko.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'fund', args: [m2.fund.ref as `0x${string}`, P.dario.addr], value: BigInt(m2.fund.amountWei) })
    view = await mirrorWait('C m2 funded', projC, t.junko, (p) => p.milestones[1]!.chainStatus === 'funded')

    await api('POST', `/projects/${projC}/milestones/${m2.id}/submissions`, {
      notes: 'Deploy scripts + fork dry-run attached. One deviation from the brief: simulation artifacts are in TOML instead of JSON (forge 1.8 format) — flagging because the handover doc said JSON.',
    }, t.dario)
    await tx(P.dario.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'submit', args: [BigInt(view.milestones[1]!.onchainId!)] })
    await mirrorWait('C m2 submitted', projC, t.junko, (p) => p.milestones[1]!.chainStatus === 'submitted')

    await api('POST', `/projects/${projC}/milestones/${m2.id}/disputes`, {
      reason: 'Deliverable deviation: handover notes specified JSON simulation artifacts, received TOML. My CI ingests JSON. Dario says forge 1.8 emits TOML natively and converting is trivial — but the work to convert is billable time neither of us budgeted. Small money, honest disagreement: who eats the conversion cost?',
    }, t.junko)
    await tx(P.junko.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'openDispute', args: [BigInt(view.milestones[1]!.onchainId!)] })
    view = await mirrorWait('C m2 disputed', projC, t.junko, (p) => p.milestones[1]!.chainStatus === 'disputed')

    const onchain2 = view.milestones[1]!.onchainId!
    const disputes = await api('GET', '/disputes', undefined, t.junko)
    const disputeC = disputes.find((d: any) => d.milestoneId === m2.id)
    await api('POST', `/disputes/${disputeC.id}/arbiter-proposal`, { arbiterAddress: P.ingrid.addr }, t.junko)
    await api('POST', `/disputes/${disputeC.id}/arbiter-proposal`, { arbiterAddress: P.ingrid.addr }, t.dario)
    await tx(P.junko.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'nominateArbiter', args: [BigInt(onchain2), P.ingrid.addr] })
    await tx(P.dario.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'nominateArbiter', args: [BigInt(onchain2), P.ingrid.addr] })

    log('project C: arbiter resolves — split')
    await tx(P.ingrid.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'resolveDispute', args: [BigInt(onchain2), 2 /* split */] })
    const settled = await mirrorWait('C m2 resolved_split + completed', projC, t.junko, (p) => p.milestones[1]!.chainStatus === 'resolved_split' && p.status === 'completed')

    await api('POST', `/milestones/${m2.id}/reviews`, { rating: 4, body: 'Split was the fair read — the format deviation was mine to flag earlier, the conversion was his to eat. Arbiter called it in 3 hours.' }, t.junko)
    await api('POST', `/milestones/${m2.id}/reviews`, { rating: 4, body: 'Agreed with the split. Next time the format goes in the milestone description on day one.' }, t.dario)

    // (arbiters are not chat participants — their rationale lives in the
    // dispute record, which the UI surfaces in the dispute panel)
    await api('POST', `/projects/${projC}/messages`, { body: 'Read Ingrid reasoning in the dispute record — format gap is shared, conversion cost split 50/50. Fair call. Closing out: handover notes updated with the converter script so your CI is unblocked today.' }, t.dario)
    await api('POST', `/projects/${projC}/messages`, { body: 'Converter script works — CI is green. Leaving the review, see you on the next drop.' }, t.junko)
  }

  log('withdrawing fees (platform housekeeping, funds the admin panel)')
  await tx(P.mara.key, { address: ESCROW, abi: ESCROW_FN, functionName: 'withdrawFees', args: [P.mara.addr] })
  await sleep(2600) // let the indexer sweep the tail events

  const final = await api('GET', '/overview')
  log(`done — users=${final.counts.users} jobs=${final.counts.jobs} projects=${final.counts.projects} ledger=${final.counts.ledgerEvents} reviews=${final.counts.reviews}`)
}

main().catch((err) => { console.error('[seed] FAILED:', err); process.exit(1) })
