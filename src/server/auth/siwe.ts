/**
 * SIWE (EIP-4361) verification — wallet-address identity (PRD F3).
 *
 * 1. POST /api/auth/nonce   → server-generated nonce (single-use, TTL, in KV)
 * 2. wallet signs the SIWE message (frontend)
 * 3. POST /api/auth/verify  → parse with the reference ABNF parser, enforce
 *    domain/chainId/freshness, recover the signer with viem, mint a session.
 *
 * Deliberately no EIP-1271 (contract-wallet) support in MVP — documented
 * trade-off; smart-account login arrives with the ERC-4337 upgrade.
 */
import { recoverMessageAddress } from 'viem'
import { ParsedMessage } from '@spruceid/siwe-parser'
import { env } from '../config'
import { getKv } from '../lib/kv'
import { Errors } from '../lib/errors'

export interface SiweVerification {
  address: string // lowercase
  nonce: string
}

export async function issueNonce(): Promise<{ nonce: string; expiresInSeconds: number }> {
  const kv = await getKv()
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  await kv.set(`siwe:nonce:${nonce}`, new Date().toISOString(), env.SIWE_NONCE_TTL_SECONDS)
  return { nonce, expiresInSeconds: env.SIWE_NONCE_TTL_SECONDS }
}

/** Throws AppError on any failure; returns the verified (lowercase) address. */
export async function verifySiwe(message: string, signature: string): Promise<SiweVerification> {
  let parsed: ParsedMessage
  try {
    parsed = new ParsedMessage(message)
  } catch {
    throw Errors.badRequest('Malformed SIWE message (EIP-4361 parse failed)')
  }

  if (parsed.domain !== env.appDomain) {
    throw Errors.badRequest(`SIWE domain mismatch: expected "${env.appDomain}", got "${parsed.domain}"`)
  }
  if (parsed.chainId !== env.CHAIN_ID) {
    throw Errors.badRequest(`SIWE chainId mismatch: expected ${env.CHAIN_ID}, got ${parsed.chainId}`)
  }
  if (parsed.version !== '1') {
    throw Errors.badRequest(`Unsupported SIWE version: ${parsed.version}`)
  }

  // freshness window: issuedAt within SIWE_MAX_AGE, expiry honoured if present
  const issuedAt = parsed.issuedAt ? Date.parse(parsed.issuedAt) : NaN
  if (!Number.isFinite(issuedAt)) throw Errors.badRequest('SIWE message must include issued-at')
  const ageSeconds = (Date.now() - issuedAt) / 1000
  if (ageSeconds > env.SIWE_MAX_AGE_SECONDS) throw Errors.badRequest('SIWE message expired (issued-at too old)')
  if (parsed.expirationTime && Date.parse(parsed.expirationTime) < Date.now()) throw Errors.badRequest('SIWE message expiration-time passed')
  if (parsed.notBefore && Date.parse(parsed.notBefore) > Date.now() + 30_000) throw Errors.badRequest('SIWE message not yet valid')

  // single-use nonce, consumed atomically
  const kv = await getKv()
  const stored = await kv.getdel(`siwe:nonce:${parsed.nonce}`)
  if (!stored) throw Errors.badRequest('Unknown, expired, or already-used nonce — request a fresh one')

  // signature check (EIP-191 personal_sign) via viem
  let recovered: string
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` })
  } catch {
    throw Errors.badRequest('Invalid signature encoding')
  }
  if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    throw Errors.unauthorized('Signature does not match the message address')
  }
  return { address: parsed.address.toLowerCase(), nonce: parsed.nonce }
}
