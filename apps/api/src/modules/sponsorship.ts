/**
 * Gasless sponsorship — login-time EIP-712 session + relayer meta-tx submit.
 *
 * ── Model ───────────────────────────────────────────────────────────────────
 *   1. LOGIN: after SIWE succeeds, the client calls GET /auth/sponsorship to
 *      fetch the EIP-712 domain + types, signs ONE `SponsorshipSession`
 *      voucher, and POSTs it back. The server stores it (DB) and mirrors it in
 *      KV. Expiry == session TTL (bound to the login session).
 *   2. ACTION: the client signs a `ForwardRequest` and POSTs it to
 *      POST /api/relay. The server (a) authenticates the JWT, (b) looks up the
 *      user's unexpired session, (c) registers the session on-chain if needed,
 *      (d) submits `forwarder.execute(req, sessionId, sig)` from the RELAYER
 *      wallet, which pays GAS.
 *
 * ── Value is never sponsored ─────────────────────────────────────────────────
 *   `SponsorshipForwarder.execute` is payable and forwards `req.value` out of
 *   the RELAYER's balance, so a sponsored request carrying value would move the
 *   platform's ETH while crediting the user: their balance never moves, there
 *   is no transfer to confirm, and a slashed arbiter bond costs the platform
 *   rather than the arbiter. Principal rides the user's own transaction
 *   (`canRelayGasless` in apps/web/lib/chain-actions.ts); assertNoSponsoredValue
 *   is the server-side backstop so a hand-rolled client cannot route around it.
 *
 * ── Authority ───────────────────────────────────────────────────────────────
 *   The CONTRACT is the authority: it re-checks the session signature + expiry
 *   and the per-request signature/nonce. The DB row is a cache/UX aid; a row
 *   lying about validity still cannot move money.
 *
 * In `mock` chain mode there is no real forwarder; the relay is simulated by
 * applying the same dev-chain emit the /dev/chain endpoints use, so the whole
 * flow is exercisable with zero infrastructure.
 */
import { and, desc, eq, gt } from 'drizzle-orm'
import { decodeErrorResult } from 'viem'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { env } from '../config.ts'
import { AppError, Errors } from '../lib/errors.ts'
import { parseOrThrow } from '../lib/http.ts'
import { getKv } from '../lib/kv.ts'
import { logger } from '../lib/logger.ts'
import { ESCROW_ERROR_ABI, FORWARDER_ERROR_ABI } from '../chain/abi.ts'
import { sponsorshipSessions, users, type SponsorshipSession } from '../db/schema.ts'

// ── EIP-712 shape (must stay byte-identical to SponsorshipForwarder.sol) ─────

export const SPONSORSHIP_EIP712_DOMAIN = {
  name: 'OpenLance SponsorshipForwarder',
  version: '1',
} as const

export const SPONSORSHIP_SESSION_TYPES = {
  SponsorshipSession: [
    { name: 'owner', type: 'address' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'sessionId', type: 'bytes32' },
  ],
} as const

export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
    { name: 'sessionId', type: 'bytes32' },
  ],
} as const

/** Whether gasless sponsorship is configured at all. */
export function sponsorshipEnabled(): boolean {
  return env.sponsorship.enabled
}

/**
 * Refuse a sponsored request that carries value. The relayer sponsors GAS
 * only: `SponsorshipForwarder.execute` is payable and would pay `req.value` out
 * of the relayer's own balance, so a value-bearing relay would credit the user
 * with the platform's ETH — their wallet balance would never move, and a slash
 * would cost the platform instead of the arbiter. Principal moves as a normal
 * user-paid transaction (`canRelayGasless` in apps/web/lib/chain-actions.ts);
 * this is the backstop for a client that skips that guard.
 */
export function assertNoSponsoredValue(valueWei: string): void {
  if (BigInt(valueWei) !== 0n) {
    throw Errors.precondition(
      'sponsored_value_not_allowed',
      'Sponsored actions cannot carry value — the relayer pays gas only. Send this as a normal transaction from your wallet.',
    )
  }
}

/** Server-generated scoping id for a sponsorship session / login challenge. */
function newSessionId(): `0x${string}` {
  return `0x${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 66) as `0x${string}`
}

/**
 * The challenge the client signs at login. `sessionId` is server-generated and
 * scopes the session (mixed into every ForwardRequest digest).
 */
export async function sponsorshipChallenge(userId: string, address: string) {
  const db = getDb()
  const sessionId = newSessionId()
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiry = issuedAt + env.sponsorship.sessionTtlSeconds

  return {
    enabled: sponsorshipEnabled(),
    domain: {
      ...SPONSORSHIP_EIP712_DOMAIN,
      chainId: env.CHAIN_ID,
      // verifyingContract is the deployed forwarder (client needs it to sign)
      verifyingContract: env.sponsorship.forwarderAddress,
    },
    types: SPONSORSHIP_SESSION_TYPES,
    primaryType: 'SponsorshipSession' as const,
    message: { owner: address, issuedAt, expiry, sessionId },
    forwardRequestTypes: FORWARD_REQUEST_TYPES,
    sessionId,
    userId,
  }
}

export const voucherSchema = z.object({
  sessionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiry: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
})

const submitSchema = voucherSchema

/** Persist a signed sponsorship session voucher (from the login flow). */
export async function storeSponsorshipSession(userId: string, address: string, body: unknown) {
  const input = parseOrThrow(submitSchema, body)
  const db = getDb()

  // Sanity: the voucher's owner must be this user's address (defence in depth —
  // the contract is what truly enforces it).
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user || user.walletAddress.toLowerCase() !== address.toLowerCase()) {
    throw Errors.forbidden('Session voucher address does not match the authenticated wallet')
  }
  if (input.expiry * 1000 < Date.now()) throw Errors.badRequest('Sponsorship session already expired')

  // Fail fast: a voucher that doesn't recover to the owner would only blow up
  // later inside the relayer as an opaque 500 (InvalidRequestSignature). Verify
  // the EIP-712 signature here so a bad wallet signature surfaces at login.
  const recovered = await recoverVoucherOwner(input, address)
  if (!recovered || recovered.toLowerCase() !== address.toLowerCase()) {
    throw Errors.badRequest('Sponsorship voucher signature does not match the authenticated wallet — disconnect and sign in again')
  }

  const id = input.sessionId.toLowerCase()
  const row = {
    id,
    userId,
    address: address.toLowerCase(),
    issuedAt: new Date(input.issuedAt * 1000),
    expiresAt: new Date(input.expiry * 1000),
    signature: input.signature,
  }
  await db
    .insert(sponsorshipSessions)
    .values(row)
    .onConflictDoUpdate({ target: sponsorshipSessions.id, set: { ...row, updatedAt: new Date() } })

  logger.info('sponsorship session stored', { userId, sessionId: id, expiry: input.expiry })
  return { sessionId: id, expiresAt: row.expiresAt.toISOString(), enabled: sponsorshipEnabled() }
}

/** The caller's newest active (unexpired) sponsorship session, if any. */
export async function activeSession(userId: string): Promise<SponsorshipSession | undefined> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(sponsorshipSessions)
    .where(and(eq(sponsorshipSessions.userId, userId), gt(sponsorshipSessions.expiresAt, new Date())))
    .orderBy(desc(sponsorshipSessions.createdAt))
    .limit(1)
  return row
}

// ── One-signature login ──────────────────────────────────────────────────────
// The EIP-712 SponsorshipSession voucher doubles as the login credential: its
// signature proves key ownership just as well as a SIWE personal_sign, and the
// forwarder contract independently requires the same digest on-chain. One
// signature therefore logs the user in AND arms gasless actions — no second
// popup. The SIWE personal_sign path remains for deployments without a
// configured forwarder.

/** Login challenges live 10 minutes and are single-use (consumed at verify). */
const LOGIN_CHALLENGE_TTL_SECONDS = 600

const loginChallengeKey = (sessionId: string) => `sponsor:login:${sessionId.toLowerCase()}`

/**
 * Public login challenge: the client signs `message` once and posts it to
 * /auth/verify. The challenge binds owner + issuedAt + expiry server-side so a
 * voucher minted for someone else (or another time) cannot log in as you.
 */
export async function issueVoucherLoginChallenge(address: string) {
  if (!sponsorshipEnabled()) return { enabled: false as const }
  const sessionId = newSessionId()
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiry = issuedAt + env.sponsorship.sessionTtlSeconds
  const kv = await getKv()
  await kv.set(loginChallengeKey(sessionId), JSON.stringify({ address: address.toLowerCase(), issuedAt, expiry }), LOGIN_CHALLENGE_TTL_SECONDS)
  return {
    enabled: true as const,
    domain: {
      ...SPONSORSHIP_EIP712_DOMAIN,
      chainId: env.CHAIN_ID,
      verifyingContract: env.sponsorship.forwarderAddress,
    },
    types: SPONSORSHIP_SESSION_TYPES,
    primaryType: 'SponsorshipSession' as const,
    message: { owner: address, issuedAt, expiry, sessionId },
    forwardRequestTypes: FORWARD_REQUEST_TYPES,
    sessionId,
  }
}

/** Recover the signer of a SponsorshipSession voucher (null when malformed). */
export async function recoverVoucherOwner(input: { sessionId: string; issuedAt: number; expiry: number; signature: string }, owner: string): Promise<string | null> {
  const { hashTypedData, recoverAddress } = await import('viem')
  const digest = hashTypedData({
    domain: { ...SPONSORSHIP_EIP712_DOMAIN, chainId: env.CHAIN_ID, verifyingContract: env.sponsorship.forwarderAddress as `0x${string}` },
    types: SPONSORSHIP_SESSION_TYPES,
    primaryType: 'SponsorshipSession',
    message: { owner: owner as `0x${string}`, issuedAt: BigInt(input.issuedAt), expiry: BigInt(input.expiry), sessionId: input.sessionId as `0x${string}` },
  })
  return recoverAddress({ hash: digest, signature: input.signature as `0x${string}` }).catch(() => null)
}

/** Consume a login challenge (single-use); throws when unknown/expired/mismatched. */
export async function consumeVoucherLoginChallenge(input: { sessionId: string; issuedAt: number; expiry: number }): Promise<{ address: string }> {
  const kv = await getKv()
  const raw = await kv.getdel(loginChallengeKey(input.sessionId))
  if (!raw) throw Errors.badRequest('Login challenge unknown, expired, or already used — request a fresh one')
  const ch = JSON.parse(raw) as { address: string; issuedAt: number; expiry: number }
  if (ch.issuedAt !== input.issuedAt || ch.expiry !== input.expiry) {
    throw Errors.badRequest('Login challenge mismatch — request a fresh one')
  }
  return { address: ch.address }
}

// ── Relayer submit ───────────────────────────────────────────────────────────

const prepareSchema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  value: z.string().regex(/^\d+$/).default('0'),
  gas: z.string().regex(/^\d+$/).default('1000000'),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
})

/**
 * Build the unsigned ForwardRequest for a money action. The server owns the
 * nonce (the forwarder's OZ Nonces counter) and the deadline, so the client can
 * never desync them. Returns the exact EIP-712 typed-data the client must sign.
 */
export async function prepareForwardRequest(userId: string, address: string, body: unknown) {
  if (!sponsorshipEnabled()) throw Errors.precondition('sponsorship_disabled', 'Gasless sponsorship is not configured on this deployment')
  const input = parseOrThrow(prepareSchema, body)
  // Refuse before the client is asked to sign anything.
  assertNoSponsoredValue(input.value)

  const session = await activeSession(userId)
  if (!session) throw Errors.forbidden('No active sponsorship session — sign in again')

  // The forwarder's OZ nonce is per-EOA across sessions — a cached counter
  // desyncs on re-login (fresh session row, count 0) or chain redeploys, and
  // every prepare after that signs a dead nonce (InvalidNonce at execute).
  // Chain is authority: read it live, fall back to the cached count.
  let nonce = session.sponsoredTxCount
  if (env.chainMode === 'real' && env.sponsorship.forwarderAddress) {
    try {
      const { createPublicClient, http, parseAbi } = await import('viem')
      const client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
      const live = await client.readContract({
        address: env.sponsorship.forwarderAddress as `0x${string}`,
        abi: parseAbi(['function nonces(address owner) view returns (uint256)']),
        functionName: 'nonces',
        args: [address as `0x${string}`],
      }) as bigint
      nonce = Number(live)
    } catch (err) {
      logger.warn('sponsor nonce live-read failed — falling back to cached count', { err: String(err) })
    }
  }
  const deadline = Math.floor(Date.now() / 1000) + 600 // 10 minutes to land

  const request = {
    from: address.toLowerCase(),
    to: input.to.toLowerCase(),
    value: input.value,
    gas: input.gas,
    nonce: String(nonce),
    deadline,
    data: input.data,
  }

  return {
    request,
    sessionId: session.id as `0x${string}`,
    domain: {
      ...SPONSORSHIP_EIP712_DOMAIN,
      chainId: env.CHAIN_ID,
      verifyingContract: env.sponsorship.forwarderAddress,
    },
    types: FORWARD_REQUEST_TYPES,
  }
}
const relaySchema = z.object({
  request: z.object({
    from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    value: z.string().regex(/^\d+$/).default('0'),
    gas: z.string().regex(/^\d+$/).default('1000000'),
    nonce: z.string().regex(/^\d+$/),
    deadline: z.number().int().positive(),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  }),
  sessionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
})

export interface RelayResult {
  txHash: string
  sessionId: string
  simulated: boolean
}

/**
 * Name a relayer revert. viem wraps errors in `ContractFunctionExecutionError`
 * with the raw data on the innermost cause, and the forwarder re-throws the
 * TARGET's revert verbatim inside `CallFailed(returnData)` — so Escrow's own
 * error is what the user needs to see, not the wrapper's name.
 *
 * Returns the target's name when it decodes, the forwarder's otherwise, and
 * null when nothing decodes.
 */
function decodeRevertName(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown })?.cause, depth++) {
    const data = (e as { data?: `0x${string}` })?.data
    if (typeof data !== 'string' || !data.startsWith('0x')) continue
    for (const abi of [FORWARDER_ERROR_ABI, ESCROW_ERROR_ABI]) {
      // viem returns { abiItem, args, errorName }; errorName is the decoded name.
      let d: { errorName?: string; args?: readonly unknown[] }
      try { d = decodeErrorResult({ abi, data }) as typeof d } catch { continue }
      const name = d?.errorName
      if (!name) continue
      if (name !== 'CallFailed') return name
      const inner = d.args?.[0]
      if (typeof inner !== 'string' || inner === '0x') return 'CallFailed'
      try {
        const t = decodeErrorResult({ abi: ESCROW_ERROR_ABI, data: inner as `0x${string}` })
        return t?.errorName ?? 'CallFailed'
      } catch { return 'CallFailed' }
    }
  }
  return null
}

/**
 * Turn a relayer/contract revert into an error the user can act on.
 *
 * Everything raised inside `submitViaForwarder` used to be rethrown verbatim.
 * A viem revert is not an AppError, so `fail()` answered `500 Internal server
 * error` — the same message for a lapsed session, a stale nonce, a target
 * refusing the call, and a genuine relayer outage. The submission had already
 * been written off-chain by then, so the freelancer saw a failure for work that
 * was recorded, with no idea what to do next.
 *
 * Two layers are decoded. The forwarder's OWN errors are in its ABI (see
 * `FORWARDER_ERRORS`), so viem names them and we map each to its remedy. The
 * TARGET's errors ride inside `CallFailed(bytes returnData)` and are decoded
 * against the escrow, because `submit`/`approve`/`release` reject on state
 * mismatch far more often than the forwarder itself does. Anything still
 * unmapped degrades to a 422 carrying the decoded name, so this class of
 * failure can never present as "Internal server error" again.
 */
function describeRelayRevert(err: unknown): AppError {
  const name = decodeRevertName(err)
  switch (name) {
    // Session lifecycle — every one of these is fixed by signing in again.
    case 'SessionExpired':
      return Errors.forbidden('Your gasless session expired before the transaction was submitted — sign in again and retry.')
    case 'SessionNotYetValid':
      return Errors.precondition('sponsorship_clock_skew', 'Your gasless session is not valid yet on-chain. The local chain clock and this server disagree — restart the dev chain and retry.')
    case 'InvalidSession':
      return Errors.forbidden('This gasless session is not registered on-chain — sign in again and retry.')
    case 'InvalidRequestSignature':
      return Errors.badRequest('The signed request did not match the authenticated wallet — reconnect and retry.')
    // OZ ECDSA, raised from inside the forwarder's own recover() calls.
    case 'ECDSAInvalidSignature':
    case 'ECDSAInvalidSignatureLength':
    case 'ECDSAInvalidSignatureS':
    case 'ECDSAInvalidSignatureV':
      return Errors.badRequest('The wallet signature could not be recovered on-chain — reconnect and sign again.')
    // Per-request state — fixed by reloading, not by re-signing in.
    case 'InvalidNonce':
      return Errors.conflict('relay_nonce_stale', 'A previous sponsored transaction is still pending, so this one used a stale nonce. Wait a moment and retry.')
    case 'RequestExpired':
      return Errors.conflict('relay_deadline_passed', 'The request took too long to reach the chain — retry.')
    // The forwarder relayed fine and the TARGET refused. Reached only when the
    // wrapped payload was itself undecodable — a named target error (WrongStatus,
    // NotFreelancer, …) is unwrapped by `decodeRevertName` and handled above.
    case 'CallFailed':
      return Errors.precondition('relay_target_reverted', 'The contract rejected this action. Refresh and retry.')
    case 'InsufficientRelayerBalance':
      return Errors.precondition('relayer_unfunded', 'The gasless relayer is out of funds. Fund RELAYER_PRIVATE_KEY, or send this action as a normal transaction.')
    case 'TransferFailed':
      return Errors.precondition('relayer_refund_failed', 'The relayer could not refund its over-payment. Try again as a normal transaction.')
    // The target's own errors, when the revert bubbled without the wrapper.
    case 'NotDisputed':
      return Errors.badRequest('Milestone is not disputed on-chain — the opening transaction may not have landed yet, or the dispute already settled. Refresh and retry.')
    case 'NotFreelancer':
      return Errors.forbidden('Only this milestone’s freelancer can do that — switch to the freelancer wallet.')
    case 'NotClient':
      return Errors.forbidden('Only the project client can do that — switch to the client wallet.')
    case 'WrongStatus':
    case 'NotDisputable':
      return Errors.conflict('milestone_state_changed', `The milestone moved on-chain since this page loaded (${name}). Refresh to see the current state.`)
    case 'UnknownMilestone':
      return Errors.notFound('Milestone')
    default:
      break
  }
  // Unmapped: still never a bare 500. Name whatever decoded, and log the raw
  // message so the next one is a one-line addition to this table.
  const raw = err instanceof Error ? err.message : String(err)
  logger.error('unmapped relay revert', { name, err: raw.slice(0, 500) })
  return Errors.precondition(
    'relay_reverted',
    name ? `The contract rejected this action (${name}). Refresh and retry.` : 'The contract rejected this action. Refresh and retry.',
  )
}

/**
 * Submit a signed ForwardRequest through the relayer. The relayer pays gas; the
 * user pays nothing in ETH. Only authenticated users with an unexpired session,
 * a request signed BY THEIR OWN ADDRESS, and a ZERO value (see
 * assertNoSponsoredValue) are accepted.
 */
export async function relayForwardRequest(userId: string, address: string, body: unknown): Promise<RelayResult> {
  if (!sponsorshipEnabled()) throw Errors.precondition('sponsorship_disabled', 'Gasless sponsorship is not configured on this deployment')

  const input = parseOrThrow(relaySchema, body)
  const req = input.request
  if (req.from.toLowerCase() !== address.toLowerCase()) {
    throw Errors.forbidden('ForwardRequest.from must be the authenticated wallet')
  }
  // The trust boundary: a value-bearing relay would move the relayer's ETH, so
  // it is refused here regardless of what the client signed or how it got here.
  assertNoSponsoredValue(req.value)

  const db = getDb()
  // Session must exist, be unexpired, and belong to this user.
  const [session] = await db
    .select()
    .from(sponsorshipSessions)
    .where(and(eq(sponsorshipSessions.id, input.sessionId.toLowerCase()), eq(sponsorshipSessions.userId, userId)))
    .limit(1)
  if (!session) throw Errors.forbidden('Unknown sponsorship session')
  if (session.expiresAt.getTime() < Date.now()) throw Errors.forbidden('Sponsorship session expired — sign in again')

  // Drain guard: cap sponsored txs per user per rolling hour.
  const kv = await (await import('../lib/kv.ts')).getKv()
  const n = await kv.incrWindow(`sponsor:rl:${userId}`, 3600)
  if (n > env.sponsorship.rateLimitPerHour) {
    throw Errors.tooMany(`Sponsored-action limit reached (${env.sponsorship.rateLimitPerHour}/hour) — retry later`)
  }

  // Mock chain: no real forwarder — synthesize the dev-chain effect so the UX
  // and session bookkeeping are exercisable with zero infrastructure.
  if (env.chainMode === 'mock') {
    const { devSponsoredFunding } = await import('./devchain.ts')
    const txHash = await devSponsoredFunding(req, address)
    await db
      .update(sponsorshipSessions)
      .set({ sponsoredTxCount: session.sponsoredTxCount + 1, updatedAt: new Date() })
      .where(eq(sponsorshipSessions.id, session.id))
    logger.info('sponsored (mock) forward', { userId, to: req.to, fn: req.data.slice(0, 10) })
    return { txHash, sessionId: session.id, simulated: true }
  }

  // Real chain: submit forwarder.execute(...) from the relayer wallet.
  const { submitViaForwarder } = await import('../chain/relayer.ts')
  let txHash: string
  try {
    txHash = await submitViaForwarder({
    request: {
      from: req.from as `0x${string}`,
      to: req.to as `0x${string}`,
      value: BigInt(req.value),
      gas: BigInt(req.gas),
      nonce: BigInt(req.nonce),
      deadline: BigInt(req.deadline),
      data: req.data as `0x${string}`,
    },
    sessionId: input.sessionId.toLowerCase() as `0x${string}`,
    signature: input.signature as `0x${string}`,
    sessionOwner: session.address as `0x${string}`,
    sessionIssuedAt: Math.floor(session.issuedAt.getTime() / 1000),
    sessionExpiry: Math.floor(session.expiresAt.getTime() / 1000),
    sessionSignature: session.signature as `0x${string}`,
    })
  } catch (err) {
    throw describeRelayRevert(err)
  }

  await db
    .update(sponsorshipSessions)
    .set({ sponsoredTxCount: session.sponsoredTxCount + 1, registeredOnchain: true, updatedAt: new Date() })
    .where(eq(sponsorshipSessions.id, session.id))

  logger.info('sponsored (relayer) forward', { userId, txHash, to: req.to })
  return { txHash, sessionId: session.id, simulated: false }
}
