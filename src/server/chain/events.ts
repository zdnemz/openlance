/** Typed, decoded chain events + uuid ↔ bytes32 ref helpers. */
import type { ChainEventName, MilestoneStatus } from '../domain/state-machine'
import type { ResolutionOutcome } from './abi'

export interface RawChainLog {
  address: string // lowercase contract address
  blockNumber: number
  blockTime: Date
  txHash: string
  logIndex: number
  name: ChainEventName
  args: Record<string, unknown>
}

// ── Event payload shapes (typed views over `args`) ──────────────────────────
export interface EvMilestoneFunded {
  milestoneId: number
  ref: string // bytes32 hex
  client: string
  freelancer: string
  amount: string // wei
}
export interface EvMilestoneSubmitted {
  milestoneId: number
  freelancer: string
}
export interface EvMilestoneReleased {
  milestoneId: number
  freelancer: string
  principal: string // wei released to freelancer (after fee)
  fee: string
  viaDisputeResolution: boolean
}
export interface EvMilestoneRefunded {
  milestoneId: number
  client: string
  amount: string
  viaDisputeResolution: boolean
}
export interface EvMilestoneSplit {
  milestoneId: number
  clientAmount: string
  freelancerAmount: string
  fee: string
}
export interface EvMilestoneCancelled {
  milestoneId: number
  client: string
  amount: string
}
export interface EvDisputeOpened {
  milestoneId: number
  by: string
  lockedAmount: string
}
export interface EvDisputeResolved {
  milestoneId: number
  arbiter: string
  outcome: ResolutionOutcome
}
// ── Multi-arbiter dispute events (contract v2) ─────────────────────────────
export interface EvArbitersSelected {
  milestoneId: number
  round: number
  arbiters: [string, string, string] // zero-padded to 3
  count: number
}
export interface EvVoteCommitted {
  milestoneId: number
  round: number
  arbiter: string
  commitHash: string
}
export interface EvVoteRevealed {
  milestoneId: number
  round: number
  arbiter: string
  outcome: number
}
export interface EvDisputeFinalized {
  milestoneId: number
  round: number
  outcome: number
  revealCount: number
  quorumMet: boolean
}
export interface EvAppealOpened {
  milestoneId: number
  newRound: number
  by: string
  appealFee: string
}
export interface EvAppealResolved {
  milestoneId: number
  round: number
  overturned: boolean
}
export interface EvArbiterRewarded {
  milestoneId: number
  arbiter: string
  amount: string
}
export interface EvArbiterPenalized {
  milestoneId: number
  arbiter: string
  reason: number
}
// ── Registry staking + score events (contract v2) ──────────────────────────
export interface EvScoreChanged {
  arbiter: string
  oldScore: number
  newScore: number
  reason: number
}
export interface EvStakeDeposited {
  arbiter: string
  amount: string
  totalStake: string
}
export interface EvStakeWithdrawn {
  arbiter: string
  amount: string
}
export interface EvStakeSlashed {
  arbiter: string
  treasury: string
  amount: string
}
export interface EvFeeWithdrawn {
  to: string
  amount: string
}
export interface EvArbiterRegistered {
  arbiter: string
  sbtTokenId: number
}
export interface EvArbiterDeregistered {
  arbiter: string
}
export interface EvTrustScoreUpdated {
  arbiter: string
  delta: number
  newScore: number
  withinSla: boolean
}

// ── uuid ↔ bytes32 (left-padded) ───────────────────────────────────────────
export function uuidToBytes32(uuid: string): `0x${string}` {
  return `0x${uuid.replace(/-/g, '').toLowerCase().padStart(64, '0')}` as `0x${string}`
}

/**
 * Reverse of uuidToBytes32. A valid ref is 64 nibbles whose first 32 are all
 * zero (the padding). Naive leading-zero stripping would corrupt uuids that
 * themselves start with '0' — a bug the smoke test caught.
 */
export function bytes32ToUuid(b32: string): string | null {
  const hex = b32.replace(/^0x/, '').toLowerCase()
  if (hex.length !== 64) return null
  if (!/^0+$/.test(hex.slice(0, 32))) return null // non-zero padding → not a uuid ref
  const t = hex.slice(32)
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`
}

/** Contract-side milestone status enum (real-mode RPC reads). */
export const ONCHAIN_MILESTONE_STATUS: Record<number, MilestoneStatus> = {
  0: 'pending_funding',
  1: 'funded',
  2: 'submitted',
  3: 'disputed',
  4: 'released',
  5: 'resolved_release',
  6: 'resolved_refund',
  7: 'resolved_split',
  8: 'cancelled',
}

/** Escrow.Phase enum ordinals → mirror enum values. */
export const ONCHAIN_DISPUTE_PHASE: Record<number, 'none' | 'commit' | 'reveal' | 'resolved'> = {
  0: 'none',
  1: 'commit',
  2: 'reveal',
  3: 'resolved',
}

/** ArbiterRegistry score-change reason codes (ScoreChanged.reason). */
export const SCORE_REASON = {
  1: 'majority',
  2: 'minority',
  3: 'missed',
  4: 'overturned',
  5: 'recovery',
} as const
export type ScoreReason = (typeof SCORE_REASON)[keyof typeof SCORE_REASON]
