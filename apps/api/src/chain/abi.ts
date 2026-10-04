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
  'event MilestoneReleased(uint256 indexed milestoneId, address freelancer, uint256 principal, uint256 fee, bool viaDisputeResolution)',
  'event MilestoneRefunded(uint256 indexed milestoneId, address client, uint256 amount, bool viaDisputeResolution)',
  'event MilestoneSplit(uint256 indexed milestoneId, uint256 clientAmount, uint256 freelancerAmount, uint256 fee)',
  'event MilestoneCancelled(uint256 indexed milestoneId, address client, uint256 amount)',
  'event FundsWithdrawn(uint256 indexed milestoneId, address indexed freelancer, uint256 amount)',
  'event FeeWithdrawn(address indexed to, uint256 amount)',
  // ── Drawdown model (lock full budget at publish, milestones draw from it) ──
  'event BudgetLocked(bytes32 indexed jobRef, address indexed client, uint256 amount)',
  'event BudgetUnlocked(bytes32 indexed jobRef, address indexed client, uint256 amount)',
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
  // ── RoleRegistry: the wallet's seat (Role enum = uint8) ────────────────
  'event RoleClaimed(address indexed account, uint8 role)',
  'event RoleSwitched(address indexed account, uint8 fromRole, uint8 toRole, uint256 fee)',
  // ── Registry events mirrored here for a single indexer surface ──────────
  'event ArbiterRegistered(address indexed arbiter, uint256 sbtTokenId)',
  'event ArbiterDeregistered(address indexed arbiter)',
  'event TrustScoreUpdated(address indexed arbiter, int256 delta, uint256 newScore, bool withinSla)',
  'event ScoreChanged(address indexed arbiter, uint256 oldScore, uint256 newScore, uint8 reason)',
  'event StakeDeposited(address indexed arbiter, uint256 amount, uint256 totalStake)',
  'event StakeReduced(address indexed arbiter, uint256 amount, uint256 remaining)',
  'event StakeLocked(address indexed arbiter, uint256 amount, uint256 score)',
  'event UnstakeRequested(address indexed arbiter, uint256 amount)',
  'event UnstakeCancelled(address indexed arbiter)',
  'event StakeWithdrawn(address indexed arbiter, uint256 amount)',
  'event StakeSlashed(address indexed arbiter, address indexed treasury, uint256 amount)',
  'event TierThresholdsUpdated(uint256 silverStake, uint256 goldStake)',
  'event MinStakeUpdated(uint256 oldMinStake, uint256 newMinStake)',
  'event MinScoreToWithdrawUpdated(uint256 oldScore, uint256 newScore)',
  'event MinStakeDurationUpdated(uint256 oldSeconds, uint256 newSeconds)',
  'event UnstakeCooldownUpdated(uint256 oldSeconds, uint256 newSeconds)',
  // RPC read surface — readContract cannot encode calls from an events-only ABI.
  'function milestoneStatus(uint256 milestoneId) view returns (uint8)',
  'function claimable(uint256 milestoneId) view returns (uint256)',
  'function accruedFees() view returns (uint256)',
  'function disputeFee() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function getRound(uint256 milestoneId, uint8 round) view returns (address[3] arbiters, uint8 arbiterCount, uint8 commitCount, uint8 revealCount, uint8[3] tally, uint64 commitDeadline, uint64 revealDeadline, bool resolved, uint8 winningOutcome)',
  'function getDispute(uint256 milestoneId) view returns (address openedBy, uint64 openedAt, uint256 fee, uint8 round, uint8 appealCount, address[3] settledArbiters, uint8 settledOutcome)',
  'function getMilestone(uint256 milestoneId) view returns (bytes32 ref, address client, address freelancer, uint256 amount, uint16 feeBps, uint8 status)',
  // ── Drawdown model ─────────────────────────────────────────────────────
  'function lockBudget(bytes32 jobRef) payable',
  'function fundFromCredit(bytes32 jobRef, bytes32 ref, address freelancer, uint256 amount)',
  'function fundAllFromCredit(bytes32 jobRef, bytes32[] refs, address[] freelancers, uint256[] amounts)',
  'function unlockBudget(bytes32 jobRef, uint256 amount)',
  'function lockedBudget(bytes32 jobRef) view returns (uint256)',
  'function reservedBudget(bytes32 jobRef) view returns (uint256)',
  'function paidOutBudget(bytes32 jobRef) view returns (uint256)',
  'function budgetLocker(bytes32 jobRef) view returns (address)',])

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

/**
 * Write-call surface for the mock chain (dev only).
 *
 * `modules/devchain.ts` receives a sponsored meta-tx and has to turn its calldata
 * back into a mock-adapter method call, which means decoding a function
 * selector. That needs write signatures, which ESCROW_ABI above deliberately
 * does not carry — it is the event + read surface the indexer depends on, and
 * widening it would blur that contract.
 *
 * So the dev-only decode surface lives here, beside the other ABI knowledge,
 * and only lists what the mock actually routes. The real chain path never
 * decodes: it forwards calldata to the contract. Keeping it separate means the
 * indexer's interface contract stays locked to events + reads.
 */
export const DEV_ESCROW_WRITE_ABI = parseAbi([
  'function fund(bytes32 ref, address freelancer) payable',
  'function submit(uint256 milestoneId)',
  'function approve(uint256 milestoneId)',
  'function cancel(uint256 milestoneId)',
  'function withdrawFees()',
])

export const DEV_REGISTRY_WRITE_ABI = parseAbi([
  'function registerArbiter() payable',
  'function requestUnstake()',
  'function withdrawStake()',
])

/**
 * The relayer's revert surface.
 *
 * `SponsorshipForwarder` reverts with custom errors, and viem can only name a
 * revert whose selector is in the ABI it was given. `FORWARDER_ABI` in
 * `chain/relayer.ts` declared only the two write functions, so EVERY failure —
 * an expired session, a stale nonce, a lapsed deadline — came back as
 * `Unable to decode signature "0x…"`, which is not an AppError and therefore
 * surfaced to the user as a bare `500 Internal server error`. The one error the
 * UI could explain (the target's `NotDisputed`) was matched by regex on that
 * undecodable message.
 *
 * These entries are the fix: the relayer's own errors now decode, and
 * `describeRelayRevert` turns them into what the user should do.
 */
export const FORWARDER_ERROR_ABI = parseAbi([
  'error InvalidSession(bytes32 sessionId)',
  'error SessionExpired(uint256 expiry)',
  'error SessionNotYetValid(uint256 issuedAt)',
  'error InvalidRequestSignature()',
  'error RequestExpired(uint48 deadline)',
  'error InvalidNonce(uint256 provided, uint256 expected)',
  'error CallFailed(bytes returnData)',
  'error InsufficientRelayerBalance()',
  'error TransferFailed()',
  // OZ's ECDSA raises these from inside the forwarder's own signature checks,
  // BEFORE its InvalidRequestSignature can fire — a malformed-length or
  // unrecoverable signature lands here, so they belong to this same surface.
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256)',
  'error ECDSAInvalidSignatureS(bytes32)',
  'error ECDSAInvalidSignatureV(uint8)',
])

/**
 * The escrow's state-mismatch reverts, for the same reason.
 *
 * These are what a user actually hits: the sponsored call relays fine and then
 * Escrow says no. They reach the relayer as the raw revert bytes inside the
 * forwarder's `CallFailed(returnData)` (the forwarder bubbles the target
 * verbatim), so they are decoded here rather than guessed from an error string.
 * `Status` is modelled as uint8 — the enum ordinals only matter for display,
 * and the surfaced message names the error rather than the numbers.
 */
export const ESCROW_ERROR_ABI = parseAbi([
  'error UnknownMilestone(uint256 milestoneId)',
  'error NotClient()',
  'error NotFreelancer()',
  'error NotParty()',
  'error NotDisputable(uint8 status)',
  'error WrongStatus(uint8 expected, uint8 actual)',
  'error NotDisputed()',
  'error NothingToWithdraw()',
  'error ArbitrationAlreadyResolved()',
])
