/**
 * Chain adapter — the seam between "the backend" and "the chain".
 *
 *  mock : a simulation of the Escrow + ArbiterRegistry contracts that emits
 *         the exact event surface through the real indexer pipeline. State is
 *         derived from the shared DB mirror on every action (so dev scripts,
 *         server restarts, and separate processes all agree), plus a small
 *         block counter in KV. Powers zero-infra local dev and the
 *         /dev/chain endpoints (never mounted in production). Fees/resolutions
 *         follow the PRD rules: fee on released portion only, 50/50 split,
 *         trust score +5 majority / −10 minority (registry deltas).
 *  real : viem public client against Base Sepolia reading real logs.
 */
import { isNotNull } from 'drizzle-orm'
import { env } from '../config'
import { logger } from '../lib/logger'
import { getKv } from '../lib/kv'
import { getDb } from '../db'
import { feeOf } from '../lib/money'
import { outcomeFromUint8, type ResolutionOutcome } from './abi'
import { uuidToBytes32 } from './events'
import type { ChainEventName, MilestoneStatus } from '../domain/state-machine'
import type { RawChainLog } from './events'
import { ledgerEvents, projectMilestones, projects, users } from '../db/schema'

export interface ChainAdapter {
  mode: 'mock' | 'real'
  chainId: number
  escrowAddress: string
  registryAddress: string
  /** Real mode only: fetch + decode logs for a block range. Mock returns []. */
  fetchLogs(fromBlock: number, toBlock: number): Promise<RawChainLog[]>
  /** Re-derive milestone status from the chain (truth for money-relevant checks). */
  getMilestoneStatus(onchainId: number): Promise<MilestoneStatus | null>
  /** Full live milestone (client, freelancer, amount, fee snapshot, status). Null when unreadable. */
  getMilestoneFull(onchainId: number): Promise<{
    client: string; freelancer: string; amountWei: string; feeBps: number; status: MilestoneStatus
  } | null>
  /** Live dispute round (selected arbiters, phase clocks, tally). Null when unreadable. */
  getDisputeRound(onchainId: number, round: number): Promise<{
    arbiters: string[]; arbiterCount: number; commitCount: number; revealCount: number
    tally: number[]; commitDeadline: number; revealDeadline: number; resolved: boolean; winningOutcome: number
  } | null>
  /** Live dispute metadata (current round + appeal count). Null when unreadable. */
  getDisputeMeta(onchainId: number): Promise<{ round: number; appealCount: number } | null>
  /** Live escrow fee config (disputeFee in wei, feeBps). Null fields fall back to env. */
  getFeeConfig(): Promise<{ disputeFeeWei: string | null; feeBps: number | null }>
  /** Live unwithdrawn platform fees (solvency input). Null when unreadable. */
  getAccruedFees(): Promise<string | null>
  /** Real mode: the escrow contract's ETH balance (solvency invariant input). Mock: null. */
  getEscrowBalance(): Promise<string | null>
  getLatestBlock(): Promise<number>
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Real adapter (viem)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * viem decodes uint/int args as BigInt; the mock chain synthesizes them as
 * strings/numbers. The indexer pipeline (ledger jsonb payload, numOrNull/str
 * coercion) speaks the MOCK shape — found live during the anvil e2e
 * ("JSON.stringify cannot serialize BigInt"). Normalizing here keeps one
 * canonical arg shape for both sources.
 */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'bigint') out[k] = v.toString()
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'bigint' ? x.toString() : x))
    else out[k] = v
  }
  return out
}

export class RealChainAdapter implements ChainAdapter {
  mode = 'real' as const
  private client: import('viem').PublicClient | undefined

  constructor(
    public chainId = env.CHAIN_ID,
    public escrowAddress = env.ESCROW_ADDRESS!.toLowerCase(),
    public registryAddress = env.ARBITER_REGISTRY_ADDRESS!.toLowerCase(),
  ) {}

  private async viem() {
    const { createPublicClient, http } = await import('viem')
    if (!this.client) {
      this.client = createPublicClient({ transport: http(env.CHAIN_RPC_URL) })
    }
    return { client: this.client! }
  }

  /**
   * Poll BOTH contracts: the escrow (milestones, disputes, fees) and the
   * arbiter registry (ArbiterRegistered/Deregistered, TrustScoreUpdated live
   * there — matching contracts/ArbiterRegistry.sol). One ABI, two addresses;
   * each log is tagged with the address it actually came from.
   */
  async fetchLogs(fromBlock: number, toBlock: number): Promise<RawChainLog[]> {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const sources = [this.escrowAddress, this.registryAddress]
    const out: RawChainLog[] = []
    for (const source of sources) {
      const logs = await client.getContractEvents({
        address: source as `0x${string}`,
        abi: ESCROW_ABI,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      })
      for (const log of logs) {
        if (!log.blockNumber) continue
        const block = await client.getBlock({ blockNumber: log.blockNumber })
        out.push({
          address: source,
          blockNumber: Number(log.blockNumber),
          blockTime: new Date(Number(block.timestamp) * 1000),
          txHash: log.transactionHash ?? '0xunknown',
          logIndex: log.logIndex ?? 0,
          name: log.eventName as ChainEventName,
          args: normalizeArgs(log.args as unknown as Record<string, unknown>),
        })
      }
    }
    return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  }

  async getMilestoneStatus(onchainId: number): Promise<MilestoneStatus | null> {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const data = await client.readContract({
      address: this.escrowAddress as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'milestoneStatus',
      args: [BigInt(onchainId)],
    }).catch((err) => {
      logger.warn('readContract milestoneStatus failed', { err: String(err) })
      return null
    })
    if (data === null) return null
    const { ONCHAIN_MILESTONE_STATUS } = await import('./events')
    return ONCHAIN_MILESTONE_STATUS[Number(data)] ?? null
  }

  async getMilestoneFull(onchainId: number) {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const raw = await client.readContract({
      address: this.escrowAddress as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'getMilestone',
      args: [BigInt(onchainId)],
    }).catch((err) => {
      logger.warn('readContract getMilestone failed', { err: String(err) })
      return null
    })
    if (!raw) return null
    const { ONCHAIN_MILESTONE_STATUS } = await import('./events')
    // viem decodes named tuple outputs to an object; fall back to positional.
    const o = raw as unknown as Record<string, unknown>
    const at = (i: number): unknown => (Array.isArray(raw) ? (raw as unknown[])[i] : undefined)
    const status = ONCHAIN_MILESTONE_STATUS[Number(o.status ?? at(5))] ?? null
    if (!status) return null
    const str = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : String(v ?? ''))
    return {
      client: String(o.client ?? at(1) ?? '').toLowerCase(),
      freelancer: String(o.freelancer ?? at(2) ?? '').toLowerCase(),
      amountWei: str(o.amount ?? at(3) ?? '0'),
      feeBps: Number(o.feeBps ?? at(4) ?? 0),
      status,
    }
  }

  async getDisputeRound(onchainId: number, round: number) {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const ZERO = '0x0000000000000000000000000000000000000000'
    const raw = await client.readContract({
      address: this.escrowAddress as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'getRound',
      args: [BigInt(onchainId), round],
    }).catch((err) => {
      logger.warn('readContract getRound failed', { err: String(err) })
      return null
    })
    if (!raw) return null
    const addrs = (raw[0] as unknown as string[]).slice(0, Number(raw[1])).filter((a) => a.toLowerCase() !== ZERO)
    return {
      arbiters: addrs.map((a) => a.toLowerCase()),
      arbiterCount: Number(raw[1]),
      commitCount: Number(raw[2]),
      revealCount: Number(raw[3]),
      tally: (raw[4] as unknown as number[]).map(Number),
      commitDeadline: Number(raw[5]),
      revealDeadline: Number(raw[6]),
      resolved: Boolean(raw[7]),
      winningOutcome: Number(raw[8]),
    }
  }

  async getDisputeMeta(onchainId: number): Promise<{ round: number; appealCount: number } | null> {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const raw = await client.readContract({
      address: this.escrowAddress as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'getDispute',
      args: [BigInt(onchainId)],
    }).catch((err) => {
      logger.warn('readContract getDispute failed', { err: String(err) })
      return null
    })
    if (!raw) return null
    // viem decodes named tuple outputs to an object; fall back to positional.
    const o = raw as unknown as Record<string, unknown>
    const at = (i: number): unknown => (Array.isArray(raw) ? (raw as unknown[])[i] : undefined)
    return { round: Number(o.round ?? at(3) ?? 0), appealCount: Number(o.appealCount ?? at(4) ?? 0) }
  }

  async getFeeConfig(): Promise<{ disputeFeeWei: string | null; feeBps: number | null }> {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const [fee, bps] = await Promise.all([
      client.readContract({ address: this.escrowAddress as `0x${string}`, abi: ESCROW_ABI, functionName: 'disputeFee' })
        .then((v) => (v as bigint).toString()).catch(() => null),
      client.readContract({ address: this.escrowAddress as `0x${string}`, abi: ESCROW_ABI, functionName: 'feeBps' })
        .then((v) => Number(v)).catch(() => null),
    ])
    return { disputeFeeWei: fee, feeBps: bps }
  }

  async getAccruedFees(): Promise<string | null> {
    const { client } = await this.viem()
    const { ESCROW_ABI } = await import('./abi')
    const data = await client.readContract({
      address: this.escrowAddress as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'accruedFees',
    }).catch((err) => {
      logger.warn('readContract accruedFees failed', { err: String(err) })
      return null
    })
    return data === null ? null : (data as bigint).toString()
  }

  /** The contract-side input of the solvency check (balance ≥ liabilities). */
  async getEscrowBalance(): Promise<string | null> {
    const { client } = await this.viem()
    const balance = await client.getBalance({ address: this.escrowAddress as `0x${string}` }).catch((err) => {
      logger.warn('getBalance failed', { err: String(err) })
      return null
    })
    return balance === null ? null : balance.toString()
  }

  async getLatestBlock(): Promise<number> {
    const { client } = await this.viem()
    return Number(await client.getBlockNumber())
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mock adapter — DB-derived state, dev-only, drives the real indexer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
interface MockMilestone {
  onchainId: number
  ref: string // bytes32 of the project_milestones uuid
  client: string
  freelancer: string
  amount: string
  status: MilestoneStatus
}
interface MockState {
  block: number
  feePot: string
  nextMilestoneId: number
  nextSbtTokenId: number
  milestones: Record<string, MockMilestone> // key: String(onchainId)
  arbiters: Record<string, { registered: boolean; sbtTokenId: number; trustScore: number; stakeWei: string; unstakeRequested: boolean; locked: boolean; registeredAt: number }>
}

const BLOCK_KEY = 'mockchain:block'
/** Mock arbiter roster — persisted in KV (NOT Postgres). Arbiter state is never
 *  an off-chain DB concern; the mock chain keeps its own simulated registry. */
const ARBITERS_KEY = 'mockchain:arbiters'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

export class MockChainAdapter implements ChainAdapter {
  mode = 'mock' as const
  chainId = env.CHAIN_ID
  escrowAddress = '0x' + 'e5c0' + '00000000000000000000000000000000000000' // unmistakably fake
  registryAddress = '0x' + 'a2b1' + '00000000000000000000000000000000000000'

  /**
   * Hydrate the simulated chain from the SHARED database (milestone mirror +
   * ledger) plus the mock registry roster in KV, so every process (API,
   * tests) sees the same chain. Arbiter state is NEVER stored in Postgres.
   */
  private async state(): Promise<MockState> {
    const db = getDb()
    const [msRows, projRows, userRows, ledger] = await Promise.all([
      db.select().from(projectMilestones).where(isNotNull(projectMilestones.onchainId)),
      db.select().from(projects),
      db.select().from(users),
      db.select({ blockNumber: ledgerEvents.blockNumber, eventType: ledgerEvents.eventType, payload: ledgerEvents.payload }).from(ledgerEvents),
    ])

    const userById = new Map(userRows.map((u) => [u.id, u]))
    const milestones: MockState['milestones'] = {}
    let maxOnchainId = 0
    for (const m of msRows) {
      const project = projRows.find((p) => p.id === m.projectId)
      const client = project ? userById.get(project.clientId) : undefined
      const freelancer = project ? userById.get(project.freelancerId) : undefined
      milestones[String(m.onchainId)] = {
        onchainId: m.onchainId!,
        ref: uuidToBytes32(m.id),
        client: client?.walletAddress ?? '0xdead',
        freelancer: freelancer?.walletAddress ?? '0xbeef',
        amount: m.amountWei,
        status: m.chainStatus,
      }
      maxOnchainId = Math.max(maxOnchainId, m.onchainId!)
    }

    const arbiterState: MockState['arbiters'] = {}
    let maxSbtTokenId = 0
    const kv = await getKv()
    // Arbiter state lives in KV, never Postgres — the mock registry is the
    // mock chain's own store (mirrors how real arbiter state lives on-chain).
    try {
      const raw = await kv.get(ARBITERS_KEY)
      if (raw) {
        for (const [addr, a] of Object.entries(JSON.parse(raw) as MockState['arbiters'])) {
          arbiterState[addr] = a
          maxSbtTokenId = Math.max(maxSbtTokenId, a.sbtTokenId ?? 0)
        }
      }
    } catch { /* fresh state */ }

    let feeAccrued = 0n
    let feeWithdrawn = 0n
    let maxBlock = 1_000_000
    for (const e of ledger) {
      maxBlock = Math.max(maxBlock, e.blockNumber)
      const p = e.payload as Record<string, unknown>
      if (e.eventType === 'MilestoneReleased' || e.eventType === 'MilestoneSplit') feeAccrued += BigInt(String(p.fee ?? '0'))
      if (e.eventType === 'FeeWithdrawn') feeWithdrawn += BigInt(String(p.amount ?? '0'))
    }

    const block = Math.max(maxBlock, Number((await kv.get(BLOCK_KEY)) ?? 0))

    return {
      block,
      feePot: (feeAccrued - feeWithdrawn).toString(),
      nextMilestoneId: maxOnchainId + 1,
      nextSbtTokenId: maxSbtTokenId + 1,
      milestones,
      arbiters: arbiterState,
    }
  }

  async fetchLogs(): Promise<RawChainLog[]> {
    return [] // the mock pushes events directly into the indexer
  }

  async getMilestoneStatus(onchainId: number): Promise<MilestoneStatus | null> {
    return (await this.state()).milestones[String(onchainId)]?.status ?? null
  }

  async getMilestoneFull(onchainId: number) {
    const m = (await this.state()).milestones[String(onchainId)]
    if (!m) return null
    // Mock has no per-party/fee snapshot beyond the mirror — status only.
    return { client: m.client, freelancer: m.freelancer, amountWei: m.amount, feeBps: env.PLATFORM_FEE_BPS, status: m.status }
  }

  async getDisputeRound(): Promise<null> {
    return null // mock derives dispute state from the DB mirror; the mirror IS the mock chain
  }

  async getDisputeMeta(): Promise<null> {
    return null // same as above — no independent round index outside the mirror
  }

  async getFeeConfig(): Promise<{ disputeFeeWei: string | null; feeBps: number | null }> {
    return { disputeFeeWei: null, feeBps: null } // env fallback; mock charges no real fees
  }

  async getAccruedFees(): Promise<string | null> {
    return null // the mock moves no real ETH; solvency is enforced by the contract tests
  }

  async getEscrowBalance(): Promise<string | null> {
    return null // the mock moves no real ETH; solvency is enforced by the contract tests
  }

  async getLatestBlock(): Promise<number> {
    return (await this.state()).block
  }

  async snapshot(): Promise<MockState> {
    return this.state()
  }

  private milestone(s: MockState, onchainId: number): MockMilestone {
    const m = s.milestones[String(onchainId)]
    if (!m) throw new Error(`mock: unknown milestone ${onchainId}`)
    return m
  }

  /** Build + ingest one synthetic log, advancing the mock block (KV-persisted). */
  private async emit(name: ChainEventName, args: Record<string, unknown>, block: number): Promise<RawChainLog> {
    const kv = await getKv()
    const next = block + 1
    await kv.set(BLOCK_KEY, String(next))
    // Registry-owned events live on the registry address (mirrors RealChainAdapter
    // polling both contracts); everything else is escrow.
    const registryEvents = new Set(['ArbiterRegistered', 'ArbiterDeregistered', 'TrustScoreUpdated', 'ScoreChanged', 'StakeDeposited', 'StakeWithdrawn', 'StakeLocked', 'StakeSlashed', 'UnstakeRequested', 'UnstakeCancelled', 'TierThresholdsUpdated', 'MinStakeUpdated', 'MinScoreToWithdrawUpdated', 'MinStakeDurationUpdated', 'UnstakeCooldownUpdated', 'ArbiterRewarded', 'ArbiterPenalized'])
    const log: RawChainLog = {
      address: registryEvents.has(name) || name.startsWith('Arbiter') ? this.registryAddress : this.escrowAddress,
      blockNumber: next,
      blockTime: new Date(),
      txHash: '0x' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
      logIndex: 0,
      name,
      args,
    }
    const { ingestEvents } = await import('./indexer')
    await ingestEvents([log])
    return log
  }

  async fund(ref: string, client: string, freelancer: string, amountWei: string): Promise<RawChainLog> {
    const s = await this.state()
    const onchainId = s.nextMilestoneId
    return this.emit('MilestoneFunded', {
      milestoneId: onchainId,
      ref,
      client: client.toLowerCase(),
      freelancer: freelancer.toLowerCase(),
      amount: amountWei,
    }, s.block)
  }

  async submit(onchainId: number, by: string): Promise<RawChainLog> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'funded') throw new Error(`mock: milestone ${onchainId} is ${m.status}, expected funded`)
    if (m.freelancer !== by.toLowerCase()) throw new Error('mock: only the freelancer may submit')
    return this.emit('MilestoneSubmitted', { milestoneId: onchainId, freelancer: m.freelancer }, s.block)
  }

  async approve(onchainId: number, by: string): Promise<RawChainLog> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'submitted') throw new Error(`mock: milestone ${onchainId} is ${m.status}, expected submitted`)
    if (m.client !== by.toLowerCase()) throw new Error('mock: only the client may approve')
    const fee = feeOf(m.amount, env.PLATFORM_FEE_BPS)
    const principal = (BigInt(m.amount) - BigInt(fee)).toString()
    return this.emit('MilestoneReleased', {
      milestoneId: onchainId, freelancer: m.freelancer, principal, fee, viaDisputeResolution: false,
    }, s.block)
  }

  async cancel(onchainId: number, by: string): Promise<RawChainLog> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'funded') throw new Error(`mock: milestone ${onchainId} is ${m.status}, expected funded`)
    if (m.client !== by.toLowerCase()) throw new Error('mock: only the client may cancel')
    return this.emit('MilestoneCancelled', { milestoneId: onchainId, client: m.client, amount: m.amount }, s.block)
  }

  async dispute(onchainId: number, by: string): Promise<RawChainLog[]> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'funded' && m.status !== 'submitted') throw new Error(`mock: milestone ${onchainId} is ${m.status}, not disputable`)
    if (m.client !== by.toLowerCase() && m.freelancer !== by.toLowerCase()) throw new Error('mock: only a party may dispute')

    const logs: RawChainLog[] = []
    logs.push(await this.emit('DisputeOpened', { milestoneId: onchainId, by: by.toLowerCase(), lockedAmount: m.amount }, s.block))

    // Model the multi-arbiter round: pick up to 3 eligible, non-party arbiters
    // (mirrors Escrow._selectArbiters → Registry.isEligible) deterministically
    // (mock has no prevrandao) and emit ArbitersSelected so the
    // dispute mirror gets a phase + selected list, matching real-mode shape.
    const nowSec = Date.now() / 1000
    const minStake = BigInt(env.MIN_STAKE_WEI)
    const pool = Object.entries(s.arbiters)
      .filter(([addr, a]) => {
        if (!a.registered || a.locked || a.unstakeRequested) return false
        if (addr === m.client || addr === m.freelancer) return false
        try { if (BigInt(a.stakeWei || '0') < minStake) return false } catch { return false }
        if (a.registeredAt + env.MIN_STAKE_DURATION_SECONDS > nowSec) return false
        return true
      })
      .map(([addr]) => addr)
    const selected = pool.slice(0, 3)
    const padded: [string, string, string] = [
      selected[0] ?? ZERO_ADDR,
      selected[1] ?? ZERO_ADDR,
      selected[2] ?? ZERO_ADDR,
    ]
    logs.push(await this.emit('ArbitersSelected', {
      milestoneId: onchainId, round: 0, arbiters: padded, count: selected.length,
    }, s.block + logs.length))
    return logs
  }

  /** Persist the mock registry roster to KV (its on-chain-state analog). */
  private async saveArbiters(s: MockState): Promise<void> {
    await (await getKv()).set(ARBITERS_KEY, JSON.stringify(s.arbiters))
  }

  async resolve(onchainId: number, arbiter: string, outcome: ResolutionOutcome, withinSla: boolean): Promise<RawChainLog[]> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'disputed') throw new Error(`mock: milestone ${onchainId} is ${m.status}, expected disputed`)
    const arb = arbiter.toLowerCase()
    if (!s.arbiters[arb]?.registered) throw new Error('mock: arbiter not registered')

    const logs: RawChainLog[] = []
    const outcomeIdx = ['release', 'refund', 'split'].indexOf(outcome)
    // Reveal + tally mirror (dev-only approximation of the commit-reveal round).
    logs.push(await this.emit('VoteRevealed', { milestoneId: onchainId, round: 0, arbiter: arb, outcome: outcomeIdx }, s.block))
    logs.push(await this.emit('DisputeFinalized', {
      milestoneId: onchainId, round: 0, outcome: outcomeIdx, revealCount: 2, quorumMet: true,
    }, s.block + logs.length))
    // the contract emits a uint8 enum: 0=release 1=refund 2=split
    logs.push(await this.emit('DisputeResolved', { milestoneId: onchainId, arbiter: arb, outcome: outcomeIdx }, s.block + logs.length))

    if (outcome === 'release') {
      const fee = feeOf(m.amount, env.PLATFORM_FEE_BPS)
      const principal = (BigInt(m.amount) - BigInt(fee)).toString()
      logs.push(await this.emit('MilestoneReleased', {
        milestoneId: onchainId, freelancer: m.freelancer, principal, fee, viaDisputeResolution: true,
      }, s.block + logs.length))
    } else if (outcome === 'refund') {
      logs.push(await this.emit('MilestoneRefunded', {
        milestoneId: onchainId, client: m.client, amount: m.amount, viaDisputeResolution: true,
      }, s.block + logs.length))
    } else {
      // split 50/50 — fee applies only to the released (freelancer) half
      const half = BigInt(m.amount) / 2n
      const fee = feeOf(half.toString(), env.PLATFORM_FEE_BPS)
      const freelancerAmount = (half - BigInt(fee)).toString()
      logs.push(await this.emit('MilestoneSplit', {
        milestoneId: onchainId, clientAmount: half.toString(), freelancerAmount, fee,
      }, s.block + logs.length))
    }

    // deterministic trust score for the mock: +5 majority, −10 minority (v2 deltas)
    const delta = withinSla ? 5 : -10
    const oldScore = s.arbiters[arb]!.trustScore
    const newScore = Math.max(0, oldScore + delta)
    // Persist the new score in the mock registry (KV) before re-deriving state.
    s.arbiters[arb] = { ...s.arbiters[arb]!, trustScore: newScore, locked: newScore < env.MIN_SCORE_TO_WITHDRAW }
    await this.saveArbiters(s)
    logs.push(await this.emit('TrustScoreUpdated', { arbiter: arb, delta, newScore, withinSla }, s.block + logs.length))
    logs.push(await this.emit('ScoreChanged', { arbiter: arb, oldScore, newScore, reason: withinSla ? 1 : 2 }, s.block + logs.length))
    return logs
  }

  async registerArbiter(address: string, stakeWei?: string): Promise<RawChainLog> {
    const s = await this.state()
    const arb = address.toLowerCase()
    if (s.arbiters[arb]?.registered) throw new Error('mock: already registered')
    const stake = stakeWei ?? env.MIN_STAKE_WEI
    if (BigInt(stake) < BigInt(env.MIN_STAKE_WEI)) throw new Error('mock: stake below minimum')
    // Permanent SBT: a returning wallet reuses its tokenId (mirrors _enroll).
    const tokenId = s.arbiters[arb]?.sbtTokenId || s.nextSbtTokenId
    // Update the mock registry (KV) directly — no off-chain arbiter table.
    s.arbiters[arb] = {
      registered: true, sbtTokenId: tokenId, trustScore: 100, stakeWei: stake,
      unstakeRequested: false, locked: false, registeredAt: Math.floor(Date.now() / 1000),
    }
    await this.saveArbiters(s)
    const log = await this.emit('ArbiterRegistered', { arbiter: arb, sbtTokenId: tokenId }, s.block)
    // _enroll emits Registered + Deposited atomically — mirror both so stakeWei converges.
    await this.emit('StakeDeposited', { arbiter: arb, amount: stake, totalStake: stake }, s.block + 1)
    return log
  }

  async deregisterArbiter(address: string): Promise<RawChainLog> {
    const s = await this.state()
    const arb = address.toLowerCase()
    if (!s.arbiters[arb]?.registered) throw new Error('mock: not registered')
    s.arbiters[arb] = { ...s.arbiters[arb]!, registered: false, stakeWei: '0', unstakeRequested: false, locked: false }
    await this.saveArbiters(s)
    return this.emit('ArbiterDeregistered', { arbiter: arb }, s.block)
  }

  async withdrawFees(to: string): Promise<RawChainLog> {
    const s = await this.state()
    return this.emit('FeeWithdrawn', { to: to.toLowerCase(), amount: s.feePot }, s.block)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let adapter: ChainAdapter | undefined
const globalForAdapter = globalThis as unknown as { __openlance_adapter?: ChainAdapter }

export function getChainAdapter(): ChainAdapter {
  if (adapter) return adapter
  if (globalForAdapter.__openlance_adapter) {
    adapter = globalForAdapter.__openlance_adapter
    return adapter
  }
  adapter = env.chainMode === 'real' ? new RealChainAdapter() : new MockChainAdapter()
  globalForAdapter.__openlance_adapter = adapter
  logger.info(`chain adapter: ${adapter.mode} (chainId ${adapter.chainId})`)
  return adapter
}

export function getMockAdapter(): MockChainAdapter {
  const a = getChainAdapter()
  if (!(a instanceof MockChainAdapter)) throw new Error('Mock chain endpoints require CHAIN_MODE=mock')
  return a
}

export { outcomeFromUint8 }
