/**
 * /arbiters — read model read STRICTLY from the on-chain ArbiterRegistry
 * (PRD F11/F12).
 *
 * There is no off-chain arbiter table and no DB fallback: the roster, the SBT
 * trust score, the stake, the tier and the eligibility clocks are all read live
 * from the contract via viem. The only off-chain data merged in is the USER
 * profile (display name / avatar / KYC state), which is identity, not registry
 * state.
 *
 * In mock mode there is no real registry, so these reads return an empty list
 * (and getArbiter throws notFound). Arbiter features are effectively disabled
 * off-chain — the contract is the single source of truth.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { cached } from '../lib/cache'
import { getKv } from '../lib/kv'
import { logger } from '../lib/logger'
import { users } from '../db/schema'
import { env } from '../config'
import { AppError, Errors } from '../lib/errors'

const log = logger.child({ component: 'arbiters' })

const TIER_SILVER_KEY = 'registry:tierSilver'
const TIER_GOLD_KEY = 'registry:tierGold'

const REGISTRY_READ_ABI = [
  'function rosterSnapshot() view returns (address[])',
  // Struct return — declared as a tuple (like the client ABI) so viem decodes
  // to an object. Flat outputs decode positionally and `info.stake` etc. come
  // back undefined → TypeError → 500 on every non-empty roster.
  'function arbiterInfo(address) view returns ((bool registered, bool unstakeRequested, uint256 tokenId, uint256 trustScore, uint256 stake, uint256 resolutions, uint256 stakedAt, uint256 unstakeRequestedAt))',
  'function minStake() view returns (uint256)',
  'function minScoreToWithdraw() view returns (uint256)',
  'function minStakeDuration() view returns (uint256)',
  'function unstakeCooldown() view returns (uint256)',
  'function tierSilver() view returns (uint256)',
  'function tierGold() view returns (uint256)',
] as const

/**
 * Live viem client for the registry. Returns null when there is no real chain
 * configured (mock mode / missing config) — callers degrade to empty, never to
 * a DB read.
 */
async function onchainClient() {
  if (env.CHAIN_MODE !== 'real' || !env.ARBITER_REGISTRY_ADDRESS || !env.CHAIN_RPC_URL) return null
  try {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
    return { client, abi: parseAbi(REGISTRY_READ_ABI), registry: env.ARBITER_REGISTRY_ADDRESS as `0x${string}` }
  } catch {
    return null
  }
}

/**
 * Resolve tier floors. Primary: read live from the registry (tierSilver /
 * tierGold). Fallback (view unavailable): indexer-synced KV override, else
 * minStake*10 / minStake*100 — the contract's initialize() defaults.
 */
async function tierThresholds(oc: Awaited<ReturnType<typeof onchainClient>>): Promise<{ silver: bigint; gold: bigint }> {
  const min = BigInt(env.MIN_STAKE_WEI)
  if (oc) {
    try {
      const [s, g] = await Promise.all([
        oc.client.readContract({ address: oc.registry, abi: oc.abi, functionName: 'tierSilver' }) as Promise<bigint>,
        oc.client.readContract({ address: oc.registry, abi: oc.abi, functionName: 'tierGold' }) as Promise<bigint>,
      ])
      return { silver: s, gold: g }
    } catch { /* fall through to KV/env mirror */ }
  }
  try {
    const kv = await getKv()
    const [s, g] = await Promise.all([kv.get(TIER_SILVER_KEY), kv.get(TIER_GOLD_KEY)])
    return {
      silver: s ? BigInt(s) : min * 10n,
      gold: g ? BigInt(g) : min * 100n,
    }
  } catch {
    return { silver: min * 10n, gold: min * 100n }
  }
}

/**
 * Resolve duration floors. Primary: read live from the registry
 * (minStakeDuration / unstakeCooldown). Fallback: indexer-synced KV, else env.
 */
async function durationThresholds(oc: Awaited<ReturnType<typeof onchainClient>>): Promise<{ minStakeDuration: number; unstakeCooldown: number }> {
  if (oc) {
    try {
      const [d, c] = await Promise.all([
        oc.client.readContract({ address: oc.registry, abi: oc.abi, functionName: 'minStakeDuration' }) as Promise<bigint>,
        oc.client.readContract({ address: oc.registry, abi: oc.abi, functionName: 'unstakeCooldown' }) as Promise<bigint>,
      ])
      return { minStakeDuration: Number(d), unstakeCooldown: Number(c) }
    } catch { /* fall through to KV/env mirror */ }
  }
  try {
    const kv = await getKv()
    const [d, c] = await Promise.all([kv.get('registry:minStakeDuration'), kv.get('registry:unstakeCooldown')])
    return {
      minStakeDuration: d ? Number(d) : env.MIN_STAKE_DURATION_SECONDS,
      unstakeCooldown: c ? Number(c) : env.UNSTAKE_COOLDOWN_SECONDS,
    }
  } catch {
    return { minStakeDuration: env.MIN_STAKE_DURATION_SECONDS, unstakeCooldown: env.UNSTAKE_COOLDOWN_SECONDS }
  }
}

/**
 * Live registry tuning for /overview config: tier floors + duration floors.
 * On-chain first (same reads as the arbiter views); KV/env fallbacks stand
 * when the RPC is unreachable or there is no real chain (mock mode).
 */
export async function getRegistryTuning(): Promise<{
  tierSilverWei: string; tierGoldWei: string; minStakeDurationSeconds: number; unstakeCooldownSeconds: number
}> {
  const oc = await onchainClient()
  const [{ silver, gold }, { minStakeDuration, unstakeCooldown }] = await Promise.all([
    tierThresholds(oc), durationThresholds(oc),
  ])
  return {
    tierSilverWei: silver.toString(), tierGoldWei: gold.toString(),
    minStakeDurationSeconds: minStakeDuration, unstakeCooldownSeconds: unstakeCooldown,
  }
}

/** Mirror of ArbiterRegistry.tierOf: 0 none · 1 bronze · 2 silver · 3 gold. */
export function tierFor(stakeWei: string, registered: boolean, silver: bigint, gold: bigint): number {
  if (!registered) return 0
  let stake = 0n
  try { stake = BigInt(stakeWei || '0') } catch { stake = 0n }
  const min = BigInt(env.MIN_STAKE_WEI)
  if (stake < min) return 0
  if (gold > 0n && stake >= gold) return 3
  if (silver > 0n && stake >= silver) return 2
  return 1
}

interface ArbiterInfo {
  registered: boolean
  unstakeRequested: boolean
  tokenId: bigint
  trustScore: bigint
  stake: bigint
  resolutions: bigint
  stakedAt: bigint
}

/** Project a live `arbiterInfo` read into the API view shape. */
function onchainView(
  address: string,
  info: ArbiterInfo,
  profile: typeof users.$inferSelect | undefined,
  tier: number,
  minStakeDuration: number,
) {
  const stakeWei = info.stake.toString()
  const trustScore = Number(info.trustScore)
  const locked = trustScore < env.MIN_SCORE_TO_WITHDRAW
  let stakeOk = false
  try { stakeOk = info.stake >= BigInt(env.MIN_STAKE_WEI) } catch { stakeOk = false }
  const stakedAtMs = Number(info.stakedAt) * 1000
  const durationOk = stakedAtMs > 0 && Date.now() >= stakedAtMs + minStakeDuration * 1000
  const registeredAt = stakedAtMs > 0 ? new Date(stakedAtMs) : null
  return {
    address,
    registered: info.registered,
    sbtTokenId: Number(info.tokenId),
    trustScore,
    stakeWei,
    tier,
    /** Below MIN_SCORE_TO_WITHDRAW: stake locked + benched from selection. */
    locked,
    unstakeRequested: info.unstakeRequested,
    /** Whether the arbiter may be drawn for new disputes (mirrors isEligible). */
    eligible: info.registered && !locked && !info.unstakeRequested && stakeOk && durationOk,
    selectableAfter: info.registered && durationOk ? null : (registeredAt ? new Date(registeredAt.getTime() + minStakeDuration * 1000).toISOString() : null),
    /** Off-chain KYC state for this address (product needs verified + tier≥bronze). */
    kycStatus: profile?.kycStatus ?? null,
    resolutions: Number(info.resolutions),
    resolutionsWithinSla: null,
    resolutionsLate: null,
    registeredAt,
    profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl } : null,
    /** ERC-5194: the trust token is soulbound — transfers revert by design. */
    soulbound: true,
  }
}

/** Load the off-chain USER profile (identity only) for a set of addresses. */
async function profilesFor(addresses: string[]): Promise<Map<string, typeof users.$inferSelect>> {
  const out = new Map<string, typeof users.$inferSelect>()
  if (addresses.length === 0) return out
  try {
    const db = getDb()
    const rows = await Promise.all(addresses.map(async (addr) => {
      const [u] = await db.select().from(users).where(eq(users.walletAddress, addr)).limit(1)
      return u
    }))
    for (const u of rows) if (u) out.set(u.walletAddress, u)
  } catch { /* identity enrichment is best-effort; registry truth stands alone */ }
  return out
}

export async function listArbiters() {
  return cached('arbiters:list', { ttlSeconds: 20, namespace: 'read' }, async () => {
    // On-chain only — no DB fallback. Mock mode → empty roster.
    // Never 500: any RPC/ABI failure degrades to an empty list (logged).
    try {
      const oc = await onchainClient()
      if (!oc) return []
      const [{ silver, gold }, { minStakeDuration }] = await Promise.all([
        tierThresholds(oc), durationThresholds(oc),
      ])
      const roster = (await oc.client.readContract({
        address: oc.registry, abi: oc.abi, functionName: 'rosterSnapshot',
      })) as `0x${string}`[]
      const addresses = roster.map((a) => a.toLowerCase())
      const profiles = await profilesFor(addresses)
      // One bad row must not sink the roster — skip it (logged) and serve the rest.
      const rows = await Promise.all(addresses.map(async (lc) => {
        try {
          const info = (await oc.client.readContract({
            address: oc.registry, abi: oc.abi, functionName: 'arbiterInfo', args: [lc as `0x${string}`],
          })) as unknown as ArbiterInfo
          return onchainView(lc, info, profiles.get(lc), tierFor(info.stake.toString(), info.registered, silver, gold), minStakeDuration)
        } catch (err) {
          log.warn('arbiterInfo read failed — skipping row', { address: lc, err: String(err) })
          return null
        }
      }))
      return rows.filter((r) => r !== null).sort((a, b) => b.trustScore - a.trustScore)
    } catch (err) {
      log.warn('listArbiters on-chain read failed — returning empty roster', { err: String(err) })
      return []
    }
  })
}

export async function getArbiter(address: string) {
  const addr = address.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw Errors.badRequest('Invalid wallet address')
  try {
    const oc = await onchainClient()
    if (!oc) throw Errors.notFound('Arbiter')
    const [{ silver, gold }, { minStakeDuration }] = await Promise.all([
      tierThresholds(oc), durationThresholds(oc),
    ])
    const info = (await oc.client.readContract({
      address: oc.registry, abi: oc.abi, functionName: 'arbiterInfo', args: [addr as `0x${string}`],
    })) as unknown as ArbiterInfo
    if (info.tokenId === 0n && !info.registered) throw Errors.notFound('Arbiter')
    const profiles = await profilesFor([addr])
    return onchainView(addr, info, profiles.get(addr), tierFor(info.stake.toString(), info.registered, silver, gold), minStakeDuration)
  } catch (err) {
    if (err instanceof AppError) throw err
    log.warn('getArbiter on-chain read failed', { address: addr, err: String(err) })
    throw Errors.notFound('Arbiter')
  }
}
