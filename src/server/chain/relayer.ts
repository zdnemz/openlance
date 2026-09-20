/**
 * Server-side relayer — submits sponsored meta-txs to the SponsorshipForwarder
 * and pays gas (and principal on testnet) from a server-held key.
 *
 * SECURITY: `RELAYER_PRIVATE_KEY` is read from env only and never leaves the
 * server. The relayer is NOT trusted by the target contracts for anything but
 * relaying: the user's own EIP-712 signature authorizes every call, and the
 * forwarder enforces the session voucher + nonce on-chain. So a leaked relayer
 * key cannot move funds that users did not sign for.
 */
import { env } from '../config'
import { Errors } from '../lib/errors'
import { logger } from '../lib/logger'

/** Minimal ABI for the forwarder (registerSession + execute). */
const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'registerSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'issuedAt', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
      { name: 'sessionId', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'req',
        type: 'tuple',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'gas', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint48' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'sessionUsed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export interface ForwardRequestInput {
  from: `0x${string}`
  to: `0x${string}`
  value: bigint
  gas: bigint
  nonce: bigint
  deadline: bigint
  data: `0x${string}`
}

export interface SubmitArgs {
  request: ForwardRequestInput
  sessionId: `0x${string}`
  /** The user's signature over the ForwardRequest digest. */
  signature: `0x${string}`
  sessionOwner: `0x${string}`
  sessionIssuedAt: number
  sessionExpiry: number
  /** The user's login-time signature over the SponsorshipSession digest. */
  sessionSignature: `0x${string}`
}

async function relayerClients() {
  const key = env.RELAYER_PRIVATE_KEY
  const forwarder = env.sponsorship.forwarderAddress
  if (!key || !forwarder) throw Errors.internal('relayer not configured')

  const { createWalletClient, createPublicClient, http } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount(key as `0x${string}`)
  const transport = http(env.CHAIN_RPC_URL)
  const wallet = createWalletClient({ account, transport })
  const publicClient = createPublicClient({ transport })
  return { wallet, publicClient, account, forwarder: forwarder as `0x${string}` }
}

/**
 * Ensure the user's login-time session voucher is registered on-chain, then
 * submit the forward request. Returns the tx hash.
 */
export async function submitViaForwarder(args: SubmitArgs): Promise<string> {
  const { wallet, publicClient, forwarder, account } = await relayerClients()

  // 1. Register the session voucher if it hasn't been already.
  const already = await publicClient.readContract({
    address: forwarder,
    abi: FORWARDER_ABI,
    functionName: 'sessionUsed',
    args: [args.sessionId],
  })
  if (!already) {
    const registerHash = await wallet.writeContract({
      address: forwarder,
      abi: FORWARDER_ABI,
      functionName: 'registerSession',
      args: [
        args.sessionOwner,
        BigInt(args.sessionIssuedAt),
        BigInt(args.sessionExpiry),
        args.sessionId,
        args.sessionSignature,
      ],
      chain: null,
    })
    await publicClient.waitForTransactionReceipt({ hash: registerHash })
    logger.info('sponsorship session registered on-chain', { sessionId: args.sessionId, tx: registerHash })
  }

  // 2. Submit the forward request; the relayer fronts gas AND `value`.
  const hash = await wallet.writeContract({
    address: forwarder,
    abi: FORWARDER_ABI,
    functionName: 'execute',
    args: [
      {
        from: args.request.from,
        to: args.request.to,
        value: args.request.value,
        gas: args.request.gas,
        nonce: args.request.nonce,
        deadline: Number(args.request.deadline),
        data: args.request.data,
      },
      args.sessionId,
      args.signature,
    ],
    value: args.request.value,
    chain: null,
  })
  return hash
}

/** Relayer wallet address (informational; for /overview). */
export async function relayerAddress(): Promise<string | null> {
  if (!env.RELAYER_PRIVATE_KEY) return null
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`).address
}
