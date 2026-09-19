/**
 * Chain adapter — the seam between "the backend" and "the chain".
 *
 *  mock : a simulation of the Escrow + ArbiterRegistry contracts that emits
 *         the exact event surface through the real indexer pipeline. State is
 *         derived from the shared DB mirror on every action (so seed scripts,
 *         server restarts, and separate processes all agree), plus a small
 *         block counter in KV. Powers zero-infra local dev and the
 *         /dev/chain endpoints (never mounted in production). Fees/resolutions
 *         follow the PRD rules: fee on released portion only, 50/50 split,
 *         trust score +1 within SLA / −2 late.
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
import { arbiters, ledgerEvents, projectMilestones, projects, users } from '../db/schema'

export interface ChainAdapter {
  mode: 'mock' | 'real'
  chainId: number
  escrowAddress: string
  registryAddress: string
  /** Real mode only: fetch + decode logs for a block range. Mock returns []. */
  fetchLogs(fromBlock: number, toBlock: number): Promise<RawChainLog[]>
  /** Re-derive milestone status from the chain (truth for money-relevant checks). */
  getMilestoneStatus(onchainId: number): Promise<MilestoneStatus | null>
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
  arbiters: Record<string, { registered: boolean; sbtTokenId: number; trustScore: number }>
}

const BLOCK_KEY = 'mockchain:block'

export class MockChainAdapter implements ChainAdapter {
  mode = 'mock' as const
  chainId = env.CHAIN_ID
  escrowAddress = '0x' + 'e5c0' + '00000000000000000000000000000000000000' // unmistakably fake
  registryAddress = '0x' + 'a2b1' + '00000000000000000000000000000000000000'

  /**
   * Hydrate the simulated chain from the SHARED database (mirror + ledger +
   * arbiter registry) so every process (seed script, API, tests) sees the
   * same chain. Only the block counter lives in KV.
   */
  private async state(): Promise<MockState> {
    const db = getDb()
    const [msRows, projRows, userRows, arbRows, ledger] = await Promise.all([
      db.select().from(projectMilestones).where(isNotNull(projectMilestones.onchainId)),
      db.select().from(projects),
      db.select().from(users),
      db.select().from(arbiters),
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
    for (const a of arbRows) {
      arbiterState[a.address] = { registered: a.registered, sbtTokenId: a.sbtTokenId ?? 0, trustScore: a.trustScore }
      maxSbtTokenId = Math.max(maxSbtTokenId, a.sbtTokenId ?? 0)
    }

    let feeAccrued = 0n
    let feeWithdrawn = 0n
    let maxBlock = 1_000_000
    for (const e of ledger) {
      maxBlock = Math.max(maxBlock, e.blockNumber)
      const p = e.payload as Record<string, unknown>
      if (e.eventType === 'MilestoneReleased' || e.eventType === 'MilestoneSplit') feeAccrued += BigInt(String(p.fee ?? '0'))
      if (e.eventType === 'FeeWithdrawn') feeWithdrawn += BigInt(String(p.amount ?? '0'))
    }

    const kv = await getKv()
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
    const log: RawChainLog = {
      address: name.startsWith('Arbiter') || name === 'TrustScoreUpdated' ? this.registryAddress : this.escrowAddress,
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

  async dispute(onchainId: number, by: string): Promise<RawChainLog> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'funded' && m.status !== 'submitted') throw new Error(`mock: milestone ${onchainId} is ${m.status}, not disputable`)
    if (m.client !== by.toLowerCase() && m.freelancer !== by.toLowerCase()) throw new Error('mock: only a party may dispute')
    return this.emit('DisputeOpened', { milestoneId: onchainId, by: by.toLowerCase(), lockedAmount: m.amount }, s.block)
  }

  async resolve(onchainId: number, arbiter: string, outcome: ResolutionOutcome, withinSla: boolean): Promise<RawChainLog[]> {
    const s = await this.state()
    const m = this.milestone(s, onchainId)
    if (m.status !== 'disputed') throw new Error(`mock: milestone ${onchainId} is ${m.status}, expected disputed`)
    const arb = arbiter.toLowerCase()
    if (!s.arbiters[arb]?.registered) throw new Error('mock: arbiter not registered')

    const logs: RawChainLog[] = []
    // the contract emits a uint8 enum: 0=release 1=refund 2=split
    logs.push(await this.emit('DisputeResolved', { milestoneId: onchainId, arbiter: arb, outcome: ['release', 'refund', 'split'].indexOf(outcome) }, s.block))

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

    // deterministic trust score: +1 within SLA, −2 late (PRD F12)
    const delta = withinSla ? 1 : -2
    const newScore = Math.max(0, s.arbiters[arb]!.trustScore + delta)
    logs.push(await this.emit('TrustScoreUpdated', { arbiter: arb, delta, newScore, withinSla }, s.block + logs.length))
    return logs
  }

  async registerArbiter(address: string): Promise<RawChainLog> {
    const s = await this.state()
    const arb = address.toLowerCase()
    if (s.arbiters[arb]?.registered) throw new Error('mock: already registered')
    return this.emit('ArbiterRegistered', { arbiter: arb, sbtTokenId: s.nextSbtTokenId }, s.block)
  }

  async deregisterArbiter(address: string): Promise<RawChainLog> {
    const s = await this.state()
    const arb = address.toLowerCase()
    if (!s.arbiters[arb]?.registered) throw new Error('mock: not registered')
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
