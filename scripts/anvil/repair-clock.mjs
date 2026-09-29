#!/usr/bin/env node
/**
 * Repair a drifted anvil clock in place — no restart, no state loss.
 *
 * Symptom: sponsored actions (including a freelancer's Escrow.submit) fail with
 * an opaque HTTP 500, because the forwarder's registerSession reverts
 * `SessionExpired`. The voucher expiry is minted from the API's wall clock but
 * the contract compares it against `block.timestamp`; once the chain clock
 * jumps ahead of wall clock by more than the session TTL, EVERY session is
 * born expired and gasless never works again.
 *
 * `evm_setNextBlockTimestamp` refuses to rewind (it rejects a timestamp below
 * the head, which is exactly the repair we need). `anvil_setTime` does not have
 * that guard: it sets the timestamp the NEXT block will carry, and `evm_mine`
 * commits it. Two calls, no restart, no state dump, escrow and funded
 * milestones untouched.
 *
 * WHAT THE REPAIR DOES NOT FIX — the part that bites. `stakedAt` is STORED, not
 * derived: ArbiterRegistry records it once, at registration, and every age rule
 * (`isEligible`, `eligibleAt`, `requestUnstake`, `reduceStake`) compares the
 * clock against it forever. Rewinding the clock therefore strands every arbiter
 * registered during the drift: `stakedAt` sits decades in the future, so
 * `isEligible` is false for the rest of time and the roster reads empty. There
 * is no recovery path — requestUnstake is gated on the same stranded value, so
 * the collateral cannot even be withdrawn. Only a redeploy clears it.
 *
 * So this script audits for that state and says so, instead of exiting
 * "nothing to do" on a chain whose clock is fine but whose arbiters are dead.
 *
 *   node scripts/anvil/repair-clock.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RPC = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'
const DEPLOYMENT = join(dirname(fileURLToPath(import.meta.url)), '.anvil-deployment.json')

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const head = async () => (await rpc('eth_getBlockByNumber', ['latest', false]))
const ts = (h) => new Date(parseInt(h.timestamp, 16) * 1000).toISOString()
const driftSecs = (h) => parseInt(h.timestamp, 16) - Math.floor(Date.now() / 1000)
const call = async (to, data) => rpc('eth_call', [{ to, data }, 'latest'])

// Minimal ABI reads, no viem (this script is dependency-free on purpose).
const SEL = { rosterSnapshot: '0x025275e3', arbiterInfo: '0x5899e0b4' } // toFunctionSelector(...)
const word = (hex, i) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'.repeat(64)}`)
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** Every roster member whose min-stake-duration clock was stranded by the rewind. */
async function strandedStakes(nowSec) {
  const { arbiterRegistry } = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'))
  const roster = await call(arbiterRegistry, SEL.rosterSnapshot)
  // Dynamic `address[]`: word 0 is the offset, word 1 the length, then the words.
  const n = Number(word(roster, 1))
  const out = []
  for (let i = 0; i < n; i++) {
    const addr = `0x${roster.slice(2 + (2 + i) * 64, 2 + (3 + i) * 64).padStart(64, '0')}`
    const info = await call(arbiterRegistry, `${SEL.arbiterInfo}${padAddr(addr)}`)
    const stakedAt = word(info, 6) // 7th member of the ArbiterInfo tuple
    if (stakedAt > BigInt(nowSec)) out.push({ addr, stakedAt })
  }
  return out
}

const before = await head()
console.log(`before: block ${parseInt(before.number, 16)}  ts ${ts(before)}  drift ${driftSecs(before)}s`)

if (Math.abs(driftSecs(before)) > 5) {
  const now = Math.floor(Date.now() / 1000)
  await rpc('anvil_setTime', [now])
  await rpc('evm_mine', [])

  const after = await head()
  const drift = driftSecs(after)
  console.log(`after:  block ${parseInt(after.number, 16)}  ts ${ts(after)}  drift ${drift}s`)
  if (Math.abs(drift) > 5) {
    console.log(`STILL DRIFTED by ${drift}s`)
    process.exit(1)
  }
  console.log('clock realigned')
} else {
  console.log('clock is already aligned — no rewind needed')
}

// The clock is trustworthy now; is the state recorded under the OLD clock?
const nowSec = Math.floor(Date.now() / 1000)
const stranded = await strandedStakes(nowSec).catch((e) => {
  console.log(`  (roster audit skipped: ${String(e).slice(0, 90)})`)
  return null
})
if (stranded === null) process.exit(0)

if (stranded.length === 0) {
  console.log('arbiter age clocks: OK — no stake clock sits beyond the repaired clock')
  process.exit(0)
}

console.log(`\n!! ${stranded.length} arbiter(s) have a STRANDED stakedAt — registered while the clock was\n` +
  `   drifted forward, now unreachable. They are ineligible for the rest of time and their\n` +
  `   collateral is frozen (requestUnstake gates on the same value). Escrow._selectArbiters\n` +
  `   will find nobody to seat, so every dispute reverts NotEnoughArbiters(0).\n`)
for (const { addr, stakedAt } of stranded) {
  console.log(`   ${addr}  stakedAt ${new Date(Number(stakedAt) * 1000).toISOString()}`)
}
console.log(`\n   Fix: restart the devnet — \`pnpm dev\` redeploys the registry, and arbiters\n` +
  `   re-register against the corrected clock. There is no on-chain recovery.\n`)
process.exit(1)
