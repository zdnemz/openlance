/**
 * The on-chain event surface OpenLance's indexer depends on.
 *
 * These ABIs are the *interface contract* between the Solidity work (Hardhat 3,
 * UUPS-upgradeable under contracts/) and the off-chain backend: the deployed
 * Escrow + ArbiterRegistry must emit exactly these events. They are defined once
 * here and shared by the real viem adapter (log decoding) and the mock chain
 * (event synthesis). The contract side locks the same surface via
 * contracts/test/event-surface.ts, so a rename on either side fails the build.
 *
 * Key decision — `MilestoneFunded` carries a `ref` (bytes32): the off-chain
 * project-milestone UUID travels inside the funding transaction so the
 * indexer can map the contract's sequential milestone id back to its row
 * deterministically. (Alternative considered: match on
 * (client, freelancer, amount) tuples — rejected as ambiguous.)
 *
 * Addresses are the *proxies* (ERC1967/UUPS), not the implementations; the
 * proxies are owned by an OZ TimelockController (TIMELOCK_ADDRESS).
 */
import { parseAbi } from 'viem'

export const ESCROW_ABI = parseAbi([
  // ── Money lifecycle (frozen) ────────────────────────────────────────────
  'event MilestoneFunded(uint256 indexed milestoneId, bytes32 indexed ref, address indexed client, address freelancer, uint256 amount)',
  'event MilestoneSubmitted(uint256 indexed milestoneId, address indexed freelancer)',
  'event MilestoneReleased(uint256 indexed milestoneId, address indexed freelancer, uint256 principal, uint256 fee, bool viaDisputeResolution)',
  'event MilestoneRefunded(uint256 indexed milestoneId, address indexed client, uint256 amount, bool viaDisputeResolution)',
  'event MilestoneSplit(uint256 indexed milestoneId, uint256 clientAmount, uint256 freelancerAmount, uint256 fee)',
  'event MilestoneCancelled(uint256 indexed milestoneId, address indexed client, uint256 amount)',
  'event FeeWithdrawn(address indexed to, uint256 amount)',
  // ── Multi-arbiter disputes (new) ────────────────────────────────────────
  'event DisputeOpened(uint256 indexed milestoneId, address indexed by, uint256 lockedAmount)',
  'event ArbitersSelected(uint256 indexed milestoneId, uint8 round, address[3] arbiters, uint8 count)',
  'event VoteCommitted(uint256 indexed milestoneId, uint8 round, address indexed arbiter, bytes32 commitHash)',
  'event VoteRevealed(uint256 indexed milestoneId, uint8 round, address indexed arbiter, uint8 outcome)',
  'event DisputeResolved(uint256 indexed milestoneId, address indexed arbiter, uint8 outcome)',
  'event DisputeFinalized(uint256 indexed milestoneId, uint8 round, uint8 outcome, uint8 revealCount, bool quorumMet)',
  'event ArbiterRewarded(uint256 indexed milestoneId, address indexed arbiter, uint256 amount)',
  'event ArbiterPenalized(uint256 indexed milestoneId, address indexed arbiter, uint8 reason)',
  'event NoQuorumFallback(uint256 indexed milestoneId, address indexed opener, uint256 refunded)',
  'event AppealOpened(uint256 indexed milestoneId, uint8 indexed newRound, address indexed by, uint256 appealFee)',
  'event AppealResolved(uint256 indexed milestoneId, uint8 round, bool overturned)',
  // ── Registry events mirrored here for a single indexer surface ──────────
  'event ArbiterRegistered(address indexed arbiter, uint256 sbtTokenId)',
  'event ArbiterDeregistered(address indexed arbiter)',
  'event TrustScoreUpdated(address indexed arbiter, int256 delta, uint256 newScore, bool withinSla)',
  'event ScoreChanged(address indexed arbiter, uint256 oldScore, uint256 newScore, uint8 reason)',
  'event StakeDeposited(address indexed arbiter, uint256 amount, uint256 totalStake)',
  'event StakeLocked(address indexed arbiter, uint256 amount, uint256 score)',
  'event UnstakeRequested(address indexed arbiter, uint256 amount)',
  'event UnstakeCancelled(address indexed arbiter)',
  'event StakeWithdrawn(address indexed arbiter, uint256 amount)',
  'event StakeSlashed(address indexed arbiter, address indexed treasury, uint256 amount)',
  // RPC read surface — readContract cannot encode calls from an events-only ABI.
  'function milestoneStatus(uint256 milestoneId) view returns (uint8)',
  'function accruedFees() view returns (uint256)',
  'function getRound(uint256 milestoneId, uint8 round) view returns (address[3] arbiters, uint8 arbiterCount, uint8 commitCount, uint8 revealCount, uint8[3] tally, uint64 commitDeadline, uint64 revealDeadline, bool resolved, uint8 winningOutcome)',
])

/** Dispute resolution outcomes — must match the contract enum. */
export const RESOLUTION_OUTCOMES = ['release', 'refund', 'split'] as const
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number]
export function outcomeFromUint8(v: number): ResolutionOutcome {
  const o = RESOLUTION_OUTCOMES[v]
  if (!o) throw new Error(`Unknown resolution outcome enum value: ${v}`)
  return o
}

/**
 * Trust-score change reasons (ArbiterRegistry REASON_* constants).
 * Emitted in ScoreChanged(arbiter, oldScore, newScore, reason).
 */
export const SCORE_REASONS = {
  1: 'majority',
  2: 'minority',
  3: 'missed',
  4: 'overturned',
  5: 'recovery',
} as const

export const ERC5192_LOCKED_EVENT = 'event Locked(uint256 indexed tokenId)'
