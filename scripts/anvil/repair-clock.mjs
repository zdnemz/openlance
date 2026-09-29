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
 *   node scripts/anvil/repair-clock.mjs
 */
const RPC = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'

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

const before = await head()
console.log(`before: block ${parseInt(before.number, 16)}  ts ${ts(before)}  drift ${driftSecs(before)}s`)

if (Math.abs(driftSecs(before)) <= 5) {
  console.log('clock is already aligned — nothing to do')
  process.exit(0)
}

const now = Math.floor(Date.now() / 1000)
await rpc('anvil_setTime', [now])
await rpc('evm_mine', [])

const after = await head()
const drift = driftSecs(after)
console.log(`after:  block ${parseInt(after.number, 16)}  ts ${ts(after)}  drift ${drift}s`)
console.log(Math.abs(drift) <= 5 ? 'clock realigned' : `STILL DRIFTED by ${drift}s`)
process.exit(Math.abs(drift) <= 5 ? 0 : 1)
