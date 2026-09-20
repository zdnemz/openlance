/** /arbiters — read model over the on-chain ArbiterRegistry mirror (PRD F11/F12). */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { cached } from '../lib/cache'
import { getKv } from '../lib/kv'
import { arbiters, users } from '../db/schema'
import { env } from '../config'
import { Errors } from '../lib/errors'

const TIER_SILVER_KEY = 'registry:tierSilver'
const TIER_GOLD_KEY = 'registry:tierGold'

/** Resolve tier floors: indexer-synced KV override, else minStake*10 / minStake*100 (contract defaults: 1 / 10 ETH). */
async function tierThresholds(): Promise<{ silver: bigint; gold: bigint }> {
  const min = BigInt(env.MIN_STAKE_WEI)
  try {
    const kv = await getKv()
    const [s, g] = await Promise.all([kv.get(TIER_SILVER_KEY), kv.get(TIER_GOLD_KEY)])
    const silver = s ? BigInt(s) : min * 10n
    const gold = g ? BigInt(g) : min * 100n
    return { silver, gold }
  } catch {
    return { silver: min * 10n, gold: min * 100n }
  }
}

/** Resolve duration floors: indexer-synced KV override, else env (contract mirrors). */
async function durationThresholds(): Promise<{ minStakeDuration: number; unstakeCooldown: number }> {
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

function view(a: typeof arbiters.$inferSelect, profile?: typeof users.$inferSelect, tier = 0, minStakeDuration = env.MIN_STAKE_DURATION_SECONDS) {
  // Mirror ArbiterRegistry.isEligible: registered + not benched + stake ≥ min +
  // staked for minStakeDuration. registeredAt doubles as stakedAt (set on enroll).
  let stakeOk = false
  try { stakeOk = BigInt(a.stakeWei || '0') >= BigInt(env.MIN_STAKE_WEI) } catch { stakeOk = false }
  let durationOk = false
  if (a.registeredAt) {
    const eligibleAtMs = new Date(a.registeredAt).getTime() + minStakeDuration * 1000
    durationOk = Date.now() >= eligibleAtMs
  }
  return {
    address: a.address,
    registered: a.registered,
    sbtTokenId: a.sbtTokenId,
    trustScore: a.trustScore,
    stakeWei: a.stakeWei,
    tier,
    /** Below MIN_SCORE_TO_WITHDRAW: stake locked + benched from selection. */
    locked: a.locked,
    unstakeRequested: a.unstakeRequested,
    /** Whether the arbiter may be drawn for new disputes (mirrors isEligible). */
    eligible: a.registered && !a.locked && !a.unstakeRequested && stakeOk && durationOk,
    selectableAfter: a.registered && durationOk ? null : (a.registeredAt ? new Date(new Date(a.registeredAt).getTime() + minStakeDuration * 1000).toISOString() : null),
    /** Off-chain KYC state for this address (product needs verified + tier≥bronze). */
    kycStatus: profile?.kycStatus ?? null,
    resolutions: a.resolutions,
    resolutionsWithinSla: a.resolutionsWithinSla,
    resolutionsLate: a.resolutionsLate,
    registeredAt: a.registeredAt,
    profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl } : null,
    /** ERC-5194: the trust token is soulbound — transfers revert by design. */
    soulbound: true,
  }
}

export async function listArbiters() {
  return cached('arbiters:list', { ttlSeconds: 20, namespace: 'read' }, async () => {
    const db = getDb()
    const [{ silver, gold }, { minStakeDuration }] = await Promise.all([tierThresholds(), durationThresholds()])
    const rows = await db.select().from(arbiters).orderBy(desc(arbiters.trustScore))
    return Promise.all(rows.map(async (a) => {
      const [u] = await db.select().from(users).where(eq(users.walletAddress, a.address)).limit(1)
      return view(a, u, tierFor(a.stakeWei, a.registered, silver, gold), minStakeDuration)
    }))
  })
}

export async function getArbiter(address: string) {
  const addr = address.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw Errors.badRequest('Invalid wallet address')
  const db = getDb()
  const [a] = await db.select().from(arbiters).where(eq(arbiters.address, addr)).limit(1)
  if (!a) throw Errors.notFound('Arbiter')
  const [u] = await db.select().from(users).where(eq(users.walletAddress, addr)).limit(1)
  const [{ silver, gold }, { minStakeDuration }] = await Promise.all([tierThresholds(), durationThresholds()])
  return view(a, u, tierFor(a.stakeWei, a.registered, silver, gold), minStakeDuration)
}
