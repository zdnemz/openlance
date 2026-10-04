/**
 * JSON-RPC relay → the env chain (anvil locally). The web's chain reads use it
 * in every environment.
 *
 * The preview browser cannot reach localhost:8545 directly, so the wallet's
 * chain transport points here: every eth_call / eth_sendRawTransaction /
 * estimate passes through the API service to the local chain. Signatures never
 * leave the browser — the relay only carries already-signed payloads.
 *
 * It used to forward ANY method from anyone: anvil's dev accounts are unlocked
 * (the deployer — timelock admin — among them) and `anvil_setCode` /
 * `anvil_impersonateAccount` / `evm_revert` are live, so a public box running
 * it could have its chain rewritten. Now: read methods plus
 * `eth_sendRawTransaction` only, rate-limited, and the upstream URL (which
 * may carry an RPC key) is never echoed.
 */
import { route } from '../../lib/route.ts'
import { Errors } from '../../lib/errors.ts'
import { readRateLimit } from '../../lib/rate-limit.ts'
import { env } from '../../config.ts'

const UPSTREAM = process.env.ANVIL_RPC_URL ?? env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'

const ALLOWED = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_sendRawTransaction',
])

export const POST = route(async (request) => {
  await readRateLimit(request)
  const body = await request.text()
  let calls: unknown
  try { calls = JSON.parse(body) } catch { throw Errors.badRequest('invalid_json', 'Body must be JSON-RPC') }
  const methods = (Array.isArray(calls) ? calls : [calls]).map((c) => (c as { method?: unknown })?.method)
  if (methods.some((m) => typeof m !== 'string' || !ALLOWED.has(m))) {
    throw Errors.forbidden('JSON-RPC method not relayed')
  }
  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    })
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'anvil relay unreachable — is the chain up?' } },
      { status: 502 },
    )
  }
})

export const GET = route(async () => Response.json({ relay: 'json-rpc' }))
