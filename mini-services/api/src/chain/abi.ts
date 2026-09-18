/**
 * The on-chain event surface EscrowLance's indexer depends on.
 *
 * These ABIs are the *interface contract* between the Solidity work (build
 * phase 2) and the off-chain backend: the deployed Escrow + ArbiterRegistry
 * must emit exactly these events. They are defined once here and shared by
 * the real viem adapter (log decoding) and the mock chain (event synthesis).
 *
 * Key decision — `MilestoneFunded` carries a `ref` (bytes32): the off-chain
 * project-milestone UUID travels inside the funding transaction so the
 * indexer can map the contract's sequential milestone id back to its row
 * deterministically. (Alternative considered: match on
 * (client, freelancer, amount) tuples — rejected as ambiguous.)
 */
import { parseAbi } from 'viem'

export const ESCROW_ABI = parseAbi([
  'event MilestoneFunded(uint256 indexed milestoneId, bytes32 indexed ref, address indexed client, address freelancer, uint256 amount)',
  'event MilestoneSubmitted(uint256 indexed milestoneId, address indexed freelancer)',
  'event MilestoneReleased(uint256 indexed milestoneId, address indexed freelancer, uint256 principal, uint256 fee, bool viaDisputeResolution)',
  'event MilestoneRefunded(uint256 indexed milestoneId, address indexed client, uint256 amount, bool viaDisputeResolution)',
  'event MilestoneSplit(uint256 indexed milestoneId, uint256 clientAmount, uint256 freelancerAmount, uint256 fee)',
  'event MilestoneCancelled(uint256 indexed milestoneId, address indexed client, uint256 amount)',
  'event DisputeOpened(uint256 indexed milestoneId, address indexed by, uint256 lockedAmount)',
  'event DisputeResolved(uint256 indexed milestoneId, address indexed arbiter, uint8 outcome)',
  'event FeeWithdrawn(address indexed to, uint256 amount)',
  'event ArbiterRegistered(address indexed arbiter, uint256 sbtTokenId)',
  'event ArbiterDeregistered(address indexed arbiter)',
  'event TrustScoreUpdated(address indexed arbiter, int256 delta, uint256 newScore, bool withinSla)',
  // RPC read surface (contracts/Escrow.sol) — readContract cannot encode calls
  // from an events-only ABI. Found during the contracts phase; the review-gating
  // and reconciliation paths depend on milestoneStatus.
  'function milestoneStatus(uint256 milestoneId) view returns (uint8)',
  'function accruedFees() view returns (uint256)',
])

/** Dispute resolution outcomes — must match the contract enum. */
export const RESOLUTION_OUTCOMES = ['release', 'refund', 'split'] as const
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number]
export function outcomeFromUint8(v: number): ResolutionOutcome {
  const o = RESOLUTION_OUTCOMES[v]
  if (!o) throw new Error(`Unknown resolution outcome enum value: ${v}`)
  return o
}

export const ERC5192_LOCKED_EVENT = 'event Locked(uint256 indexed tokenId)'
