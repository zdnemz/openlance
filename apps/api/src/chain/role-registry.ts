/**
 * RoleRegistry — the wallet-owned seat, read live. `users.role` is a MIRROR of
 * this contract (see docs/intent/role-onchain.md), so every place that writes
 * the column has to answer to what the chain says first.
 *
 * Why it matters: the off-chain row dies with the database. A wallet that had
 * claimed `arbiter` came back as the `client` column default after a reset,
 * re-ran onboarding, and could pick a different seat for free. The chain is the
 * only record that survives, so it is the authority — this module is the one
 * place the backend asks it.
 *
 * Failure modes are deliberately DISTINGUISHED, because they mean opposite
 * things for a write:
 *   · `off`        — no chain authority on this deployment (mock / unconfigured).
 *                    There is no seat anywhere but the DB, so the DB decides.
 *   · `unreadable` — the registry IS configured but did not answer. A wallet-
 *                    owned asset must fail CLOSED: we will not write a seat we
 *                    could not verify, or an RPC outage becomes a free role
 *                    change for whoever signs in during it.
 *   · `none`       — configured, answered, never claimed. The one free write is
 *                    still available, but only as an on-chain `claim`.
 */
import { env } from '../config.ts'
import { Errors } from '../lib/errors.ts'
import { logger } from '../lib/logger.ts'

export type OnchainRole = 'client' | 'freelancer' | 'arbiter'

/** IRoleRegistry.Role ordinals — the ABI type of an enum is its uint8. */
const ROLE_BY_ORDINAL = [null, 'client', 'freelancer', 'arbiter'] as const

export const ROLE_ORDINAL: Record<OnchainRole, number> = { client: 1, freelancer: 2, arbiter: 3 }

const ROLE_REGISTRY_READ_ABI = [
  'function roleOf(address) view returns (uint8)',
] as const

export type SeatRead =
  | { state: 'off' }
  | { state: 'unreadable' }
  | { state: 'none' }
  | { state: 'claimed'; role: OnchainRole }

/** True when this deployment has an on-chain seat to be authoritative about. */
export function seatAuthorityConfigured(): boolean {
  return env.chainMode === 'real' && !!env.ROLE_REGISTRY_ADDRESS
}

/**
 * Live seat for `address`. One `eth_call`, no caching: it runs at login and at
 * the single role write, and a stale answer here is a wrong seat.
 */
export async function readSeat(address: string): Promise<SeatRead> {
  if (!seatAuthorityConfigured()) return { state: 'off' }
  try {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
    const ordinal = Number(
      await client.readContract({
        address: env.ROLE_REGISTRY_ADDRESS as `0x${string}`,
        abi: parseAbi(ROLE_REGISTRY_READ_ABI),
        functionName: 'roleOf',
        args: [address as `0x${string}`],
      }),
    )
    const role = ROLE_BY_ORDINAL[ordinal] ?? null
    return role ? { state: 'claimed', role } : { state: 'none' }
  } catch (err) {
    logger.warn('role registry read failed', { address, err: err instanceof Error ? err.message : String(err) })
    return { state: 'unreadable' }
  }
}

/**
 * Whether `requested` may become the off-chain mirror, given what the chain
 * says. Pure — the whole rule, no I/O, so it is provable on its own.
 *
 * The invariant: the column may only ever hold a seat the wallet has claimed.
 * A change after the first claim is a paid `switchRole` transaction, never a
 * free API write.
 */
export function verifySeatClaim(read: SeatRead, requested: OnchainRole): void {
  switch (read.state) {
    case 'off':
      return // no chain seat exists on this deployment — the DB is the seat
    case 'unreadable':
      throw Errors.precondition('seat_unreadable', 'Cannot reach the on-chain seat registry — retry in a moment')
    case 'none':
      throw Errors.conflict('seat_not_claimed', 'Claim your seat on-chain before confirming it here')
    case 'claimed':
      if (read.role !== requested) {
        throw Errors.conflict(
          'seat_locked',
          `This wallet's seat is "${read.role}" on-chain — it cannot be changed from here`,
        )
      }
  }
}
