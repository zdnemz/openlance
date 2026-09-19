/**
 * One-off: register two extra arbiters (Nils, Priya) on the LIVE stack so the
 * trust registry reads like a live leaderboard. Mirrors seed-real.ts logic;
 * the seed itself now includes these personas for future boots.
 *
 * Idempotent: skips addresses the registry already knows.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { anvil } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RPC = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'
const API = process.env.APP_URI?.replace(/\/$/, '') ?? 'http://localhost:3000'
const here = dirname(fileURLToPath(import.meta.url))
const deployment = JSON.parse(readFileSync(resolve(here, '.anvil-deployment.json'), 'utf8')) as {
  escrow: `0x${string}`; arbiterRegistry: `0x${string}`
}
const REGISTRY = deployment.arbiterRegistry

const MARA = { key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', addr: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' }
const EXTRA = [
  {
    key: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
    addr: '0x976ea74026e726554db657fa54763abd0c3a0aa9',
    name: 'Nils Ekmann',
    bio: 'Backend auditor turned arbiter. Ex-Erigon contributor; I read diffs for fun and settle on the spec, not the volume of the argument.',
    skills: ['auditing', 'golang', 'protocol-design'],
  },
  {
    key: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
    addr: '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
    name: 'Priya Raghunathan',
    bio: 'Formal-methods engineer (TLA+, Certora). Arbiter on the side — disputes with a written spec end in one read; disputes without one end in questions.',
    skills: ['formal-methods', 'solidity', 'certora'],
  },
]

const REGISTRY_FN = parseAbi([
  'function register(address arbiter)',
  'function isRegistered(address) view returns (bool)',
])

const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (key: string) => createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain: anvil, transport: http(RPC) })
const acct = (key: string) => privateKeyToAccount(key as `0x${string}`)

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

const log = (m: string) => console.log(`[extra-arbiters] ${m}`)

for (const a of EXTRA) {
  const already = await publicClient.readContract({
    address: REGISTRY, abi: REGISTRY_FN, functionName: 'isRegistered', args: [a.addr as `0x${string}`],
  })
  if (already) { log(`${a.name} already registered — skipping`); continue }

  log(`${a.name}: profile`)
  const token = await siweLogin(a)
  await api('PATCH', '/users/me', { displayName: a.name, role: 'freelancer', bio: a.bio, skills: a.skills }, token)

  log(`${a.name}: on-chain register`)
  const hash = await wallet(MARA.key).writeContract({
    address: REGISTRY, abi: REGISTRY_FN, functionName: 'register', args: [a.addr as `0x${string}`],
    account: acct(MARA.key), chain: anvil,
  })
  await publicClient.waitForTransactionReceipt({ hash })
  log(`${a.name}: done (tx ${hash})`)
}
log('complete')
