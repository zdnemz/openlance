// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IArbiterRegistry} from "./IArbiterRegistry.sol";
import {ERC2771ContextLite} from "./ERC2771ContextLite.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title Escrow — milestone money + MULTI-ARBITER dispute resolution
 * @notice ONE contract holding every milestone (not a factory of per-project
 *         clones): fee and settlement logic is cross-project and a single
 *         accounting surface is what the invariant tests protect.
 *
 *         ══════════════════ Milestone lifecycle ══════════════════
 *
 *                                            ┌── approve ──> Released
 *              fund      submit              │
 *   (off-chain) ──> Funded ──> Submitted ─────┤
 *                │      │                     │
 *                │      └──── dispute ──> Disputed ── resolve ──> ResolvedRelease
 *                │                                   │         ├─> ResolvedRefund
 *                └── cancel ──> Cancelled             │         └─> ResolvedSplit
 *
 *         ══════════════════ Multi-arbiter dispute ══════════════════
 *
 *   openDispute{value: fee}            — either party; picks up to 3 eligible,
 *                                        non-party arbiters at random.
 *        │
 *        ├─ commitVote(id, hash)       — COMMIT phase: each arbiter hides
 *        │                               keccak256(abi.encode(outcome, salt)).
 *        ▼
 *   [commit deadline passes / all committed]
 *        │
 *        ├─ revealVote(id, outcome, salt) — REVEAL phase: hash must match the commit.
 *        ▼
 *   [reveal deadline passes / all revealed]
 *        │
 *        └─ resolveDispute(id)          — PERMISSIONLESS tally. Majority (2-of-3)
 *                                          decides Release/Refund/Split and the
 *                                          payout executes. Majority arbiters
 *                                          split the reward; minority and
 *                                          non-revealers are penalised. If fewer
 *                                          than 2 revealed, a no-quorum fallback
 *                                          refunds the opener.
 *        │
 *        └─ appeal(id){value}           — a party may appeal within the window;
 *                                          a fresh round runs; if the result
 *                                          differs the original majority is
 *                                          penalised −25 each.
 *
 * @dev UPGRADEABLE (UUPS), owner = TimelockController in production.
 *
 *      SECURITY INVARIANTS:
 *       1. Solvency — balance >= Σ unsettled milestone amounts + accruedFees.
 *       2. Milestones settle at most once; settled milestones are terminal.
 *       3. Reentrancy-guarded payout paths, checks-effects-interactions ordered.
 *       4. Direct ETH transfers revert, so the balance maps 1:1 to liabilities.
 *       5. A dispute never selects an arbiter who is a party to that milestone.
 *
 *      RANDOMNESS CAVEAT: arbiter selection uses `prevrandao` + block metadata.
 *      This is weak (a block producer can bias it) but adequate for the MVP and
 *      testnet; a mainnet deployment should migrate to Chainlink VRF via an
 *      upgrade. The exposure is bounded: a biased producer can only reorder WHICH
 *      eligible arbiters are drawn, and the 2-of-3 commit-reveal quorum plus
 *      staking/slashing still gate the money.
 */
contract Escrow is Ownable2StepUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient, ERC2771ContextLite {
    // ─────────────────────────────────────────────────────────────────────────
    // Types — Status ordinal positions are API: the backend maps uint8 → name
    // (ONCHAIN_MILESTONE_STATUS in src/server/chain/events.ts). Never reorder.
    // ─────────────────────────────────────────────────────────────────────────

    enum Status {
        PendingFunding, // 0 — off-chain only: a template row not yet funded
        Funded, // 1
        Submitted, // 2
        Disputed, // 3
        Released, // 4 — client approved
        ResolvedRelease, // 5 — arbitration ruled: release
        ResolvedRefund, // 6 — arbitration ruled: refund
        ResolvedSplit, // 7 — arbitration ruled: split
        Cancelled // 8 — client cancelled before submission (full refund)
    }

    enum Outcome {
        Release, // 0
        Refund, // 1
        Split // 2
    }

    enum Phase {
        None, // 0 — no dispute
        Commit, // 1 — arbiters commit hashed votes
        Reveal, // 2 — arbiters reveal votes
        Resolved // 3 — decision executed (or no-quorum fallback)
    }

    struct Milestone {
        bytes32 ref; // off-chain milestone uuid, left-padded (indexer join key)
        address client; // funder
        address freelancer; // payee on release
        uint256 amount; // wei, immutable after funding
        uint16 feeBps; // platform fee snapshot at funding (in-flight changes never apply)
        Status status;
    }

    /// @dev A single arbitration round. Appeals create a new round (`round`).
    struct Round {
        address[3] arbiters; // selected arbiters (zero-padded if fewer eligible)
        uint8 arbiterCount; // how many were actually selected (1–3)
        mapping(address => bytes32) commits; // arbiter => commit hash
        mapping(address => bool) revealed; // arbiter => revealed?
        mapping(address => uint8) votes; // arbiter => revealed outcome
        // Stake snapshot captured at selection time (ArbitersSelected), used to
        // weight the reward pot proportionally. Snapshotting — rather than
        // reading stakeOf() at finalize — blocks the attack where an arbiter
        // tops up their stake AFTER being drawn to seize a larger share.
        mapping(address => uint256) stakeWeights;
        uint8 commitCount;
        uint8 revealCount;
        uint8[3] tally; // votes per Outcome ordinal
        uint64 commitDeadline;
        uint64 revealDeadline;
        bool resolved;
        uint8 winningOutcome;
    }

    struct Dispute {
        address openedBy;
        uint64 openedAt;
        uint256 fee; // dispute fee paid by the opener (funds arbiter rewards)
        uint8 round; // current round index (0 = original, 1+ = appeals)
        uint8 appealCount;
        address[3] settledArbiters; // majority of the settled round (for overturn penalty)
        uint8 settledOutcome;
    }

    // ── Milestone/money events (frozen backend interface) ─────────────────────

    event MilestoneFunded(uint256 indexed milestoneId, bytes32 indexed ref, address indexed client, address freelancer, uint256 amount);
    event MilestoneSubmitted(uint256 indexed milestoneId, address indexed freelancer);
    event MilestoneReleased(uint256 indexed milestoneId, address freelancer, uint256 principal, uint256 fee, bool viaDisputeResolution);
    event MilestoneRefunded(uint256 indexed milestoneId, address client, uint256 amount, bool viaDisputeResolution);
    event MilestoneSplit(uint256 indexed milestoneId, uint256 clientAmount, uint256 freelancerAmount, uint256 fee);
    event MilestoneCancelled(uint256 indexed milestoneId, address client, uint256 amount);
    event FeeWithdrawn(address indexed to, uint256 amount);

    // ── Dispute events (spec §5) ──────────────────────────────────────────────

    event DisputeOpened(uint256 indexed milestoneId, address indexed by, uint256 lockedAmount);
    event ArbitersSelected(uint256 indexed milestoneId, uint8 round, address[3] arbiters, uint8 count);
    event VoteCommitted(uint256 indexed milestoneId, uint8 round, address indexed arbiter, bytes32 commitHash);
    event VoteRevealed(uint256 indexed milestoneId, uint8 round, address indexed arbiter, uint8 outcome);
    event DisputeResolved(uint256 indexed milestoneId, address indexed arbiter, uint8 outcome);
    event DisputeFinalized(uint256 indexed milestoneId, uint8 round, uint8 outcome, uint8 revealCount, bool quorumMet);
    event ArbiterRewarded(uint256 indexed milestoneId, address indexed arbiter, uint256 amount);
    event ArbiterPenalized(uint256 indexed milestoneId, address indexed arbiter, uint8 reason);
    event NoQuorumFallback(uint256 indexed milestoneId, address indexed opener, uint256 refunded);
    event AppealOpened(uint256 indexed milestoneId, uint8 indexed newRound, address indexed by, uint256 appealFee);
    event AppealResolved(uint256 indexed milestoneId, uint8 round, bool overturned);
    event RewardsDeposited(address indexed from, uint256 amount);
    event DisputeFeeUpdated(uint256 oldFee, uint256 newFee);

    // ── Admin/ops events ──────────────────────────────────────────────────────

    event PlatformFeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InvalidFreelancer();
    error UnknownMilestone(uint256 milestoneId);
    error NotClient();
    error NotFreelancer();
    error NotParty();
    error NotDisputable(Status status);
    error WrongStatus(Status expected, Status actual);
    error NotDisputed();
    error InvalidOutcome(uint8 outcome);
    error FeeTooHigh(uint16 requested, uint16 max);
    error NothingToWithdraw();
    error TransferFailed();
    error DisputeFeeTooLow(uint256 provided, uint256 required);
    error NotEnoughArbiters(uint256 eligible);
    error WrongPhase(Phase expected, Phase actual);
    error NotSelectedArbiter();
    error AlreadyCommitted();
    error CommitDeadlinePassed();
    error NoneCommitted();
    error CommitDeadlineNotPassed();
    error RevealWindowClosed();
    error AlreadyRevealed();
    error CommitMismatch();
    error RevealWindowOpen();
    error NotEnoughReveals(uint8 revealed, uint8 required);
    error ArbitrationAlreadyResolved();
    error AppealWindowClosed();
    error AppealWindowOpen();
    error AppealAlreadyOpen();

    // ── Constants ─────────────────────────────────────────────────────────────

    uint16 public constant MAX_FEE_BPS = 500; // 5% platform fee cap
    uint8 public constant MAX_ARBITERS = 3; // spec §2
    uint8 public constant QUORUM = 2; // spec §2 — minimum reveals to decide

    // ── Storage ───────────────────────────────────────────────────────────────

    IArbiterRegistry public arbiterRegistry;

    uint16 public feeBps; // platform fee snapshot target for new milestones
    uint256 public disputeFee; // minimum ETH a party must pay to open a dispute
    uint64 public commitWindow; // duration of the commit phase
    uint64 public revealWindow; // duration of the reveal phase
    uint64 public appealWindow; // after finalization, how long a party may appeal
    address public treasury; // receives slashed collateral + undistributed fees

    mapping(uint256 => Milestone) private milestones_;
    mapping(uint256 => Dispute) private disputes_; // keyed by milestoneId
    mapping(uint256 => mapping(uint8 => Round)) private rounds_; // milestoneId => round
    mapping(address => uint256) public activeDisputes; // arbiter => count of in-flight rounds

    uint256 public nextMilestoneId; // id 0 is never used
    uint256 public accruedFees; // unwithdrawn platform fees (solvency invariant)
    uint256 public rewardPool; // protocol-subsidised arbiter rewards

    /// @dev Reserved storage for future upgrades.
    uint256[38] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy atomically.
     * @param arbiterRegistry_ the arbiter registry (stake + trust + eligibility)
     * @param owner_           upgrade/admin authority (TimelockController in prod)
     * @param feeBps_          initial platform fee in bps (<= MAX_FEE_BPS)
     * @param disputeFee_      minimum ETH to open a dispute (funds arbiter rewards)
     * @param treasury_        receives slashed fees / undistributed rewards
     * @param commitWindow_    commit-phase duration in seconds
     * @param revealWindow_    reveal-phase duration in seconds
     * @param appealWindow_    appeal window after finalization, seconds
     * @param trustedForwarder_ ERC-2771 forwarder trusted for gasless meta-txs
     *                          (address(0) disables sponsorship forwarding)
     */
    function initialize(
        IArbiterRegistry arbiterRegistry_,
        address owner_,
        uint16 feeBps_,
        uint256 disputeFee_,
        address treasury_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint64 appealWindow_,
        address trustedForwarder_
    ) external initializer {
        if (address(arbiterRegistry_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);

        __Ownable_init(owner_);
        __ERC2771ContextLite_init(trustedForwarder_);
        arbiterRegistry = arbiterRegistry_;
        feeBps = feeBps_;
        disputeFee = disputeFee_;
        treasury = treasury_ == address(0) ? owner_ : treasury_;
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
        appealWindow = appealWindow_;
        nextMilestoneId = 1; // id 0 is never used
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Funding
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Fund a milestone: the client escrows `msg.value` for `freelancer`.
     * @dev    No external calls happen here, so no reentrancy guard is needed.
     */
    function fund(bytes32 ref, address freelancer) external payable {
        if (msg.value == 0) revert ZeroAmount();
        address client = _msgSender();
        if (freelancer == address(0) || freelancer == client) revert InvalidFreelancer();

        uint256 milestoneId = nextMilestoneId++;
        Milestone storage m = milestones_[milestoneId];
        m.ref = ref;
        m.client = client;
        m.freelancer = freelancer;
        m.amount = msg.value;
        m.feeBps = feeBps; // snapshot: later fee changes never touch in-flight milestones
        m.status = Status.Funded;

        emit MilestoneFunded(milestoneId, ref, client, freelancer, msg.value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy path
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Freelancer signals work is delivered.
    function submit(uint256 milestoneId) external {
        Milestone storage m = _m(milestoneId);
        address freelancer = _msgSender();
        if (freelancer != m.freelancer) revert NotFreelancer();
        if (m.status != Status.Funded) revert WrongStatus(Status.Funded, m.status);

        m.status = Status.Submitted;
        emit MilestoneSubmitted(milestoneId, freelancer);
    }

    /// @notice Client approves delivered work: fee is taken, principal released.
    function approve(uint256 milestoneId) external nonReentrant {
        Milestone storage m = _m(milestoneId);
        if (_msgSender() != m.client) revert NotClient();
        if (m.status != Status.Submitted) revert WrongStatus(Status.Submitted, m.status);

        m.status = Status.Released; // EFFECT before INTERACTION (CEI)
        uint256 fee = _feeOn(m.amount, m.feeBps);
        uint256 principal = m.amount - fee;
        accruedFees += fee;

        emit MilestoneReleased(milestoneId, m.freelancer, principal, fee, false);
        _pay(m.freelancer, principal);
    }

    /// @notice Client cancels a funded (not yet submitted) milestone: full refund.
    function cancel(uint256 milestoneId) external nonReentrant {
        Milestone storage m = _m(milestoneId);
        if (_msgSender() != m.client) revert NotClient();
        if (m.status != Status.Funded) revert WrongStatus(Status.Funded, m.status);

        m.status = Status.Cancelled;
        emit MilestoneCancelled(milestoneId, m.client, m.amount);
        _pay(m.client, m.amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Disputes — open + arbiter selection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Either party locks a funded/submitted milestone into dispute and
     *         pays the dispute fee. Up to MAX_ARBITERS eligible, non-party
     *         arbiters are selected at random from the registry.
     * @dev    The opener must send at least `disputeFee`; any excess is treated as
     *         an extra reward contribution.
     */
    function openDispute(uint256 milestoneId) external payable nonReentrant {
        Milestone storage m = _m(milestoneId);
        address opener = _msgSender();
        if (opener != m.client && opener != m.freelancer) revert NotParty();
        if (m.status != Status.Funded && m.status != Status.Submitted) revert NotDisputable(m.status);
        if (msg.value < disputeFee) revert DisputeFeeTooLow(msg.value, disputeFee);

        m.status = Status.Disputed;
        Dispute storage d = disputes_[milestoneId];
        d.openedBy = opener;
        d.openedAt = uint64(block.timestamp);
        d.fee = msg.value;

        emit DisputeOpened(milestoneId, opener, m.amount);

        _startRound(milestoneId, m, 0);
    }

    /**
     * @notice Select up to MAX_ARBITERS eligible, non-party arbiters for a new
     *         round using `prevrandao`. Reverts if fewer than QUORUM are available.
     * @dev    Randomness caveat: see the contract-level note. Draws are without
     *         replacement from the eligible set.
     */
    function _startRound(uint256 milestoneId, Milestone storage m, uint8 round) private {
        address[3] memory picked;
        uint8 count = _selectArbiters(milestoneId, m.client, m.freelancer, round, picked);

        if (count < QUORUM) revert NotEnoughArbiters(count);

        Round storage r = rounds_[milestoneId][round];
        r.arbiters = picked;
        r.arbiterCount = count;
        r.commitDeadline = uint64(block.timestamp) + commitWindow;
        r.revealDeadline = r.commitDeadline + revealWindow;

        for (uint8 i = 0; i < count; i++) {
            activeDisputes[picked[i]] += 1;
            // Snapshot the stake weight at selection so a late top-up cannot
            // inflate this round's reward share. A zero read (registry absent,
            // or arbiter deregistered between read and select) falls back to 1
            // so a valid arbiter is never silently dropped from the split.
            uint256 w = arbiterRegistry.stakeOf(picked[i]);
            r.stakeWeights[picked[i]] = w == 0 ? 1 : w;
        }

        emit ArbitersSelected(milestoneId, round, picked, count);
    }

    /**
     * @dev Random selection without replacement from the registry's live roster,
     *      excluding the two parties and any arbiter already picked.
     *
     *      Randomness: `prevrandao` (post-merge RANDAO beacon) mixed with block
     *      metadata. This is a pseudo-random, miner-influenceable source — see the
     *      contract-level caveat. Bias here can only reorder which *eligible*,
     *      non-party arbiters are drawn; the money is still gated by the 2-of-3
     *      commit-reveal quorum and by staking/slashing.
     *
     *      Draws are bounded: we make at most `POOL_SCAN` passes over the roster,
     *      so a large or adversarial roster cannot cause unbounded gas.
     */
    uint256 private constant POOL_SCAN = 3;

    function _selectArbiters(
        uint256 milestoneId,
        address client,
        address freelancer,
        uint8 round,
        address[3] memory picked
    ) private view returns (uint8 count) {
        uint256 len = _rosterLength();
        if (len < QUORUM) return 0; // not enough arbiters to ever reach quorum

        uint256 seed = uint256(
            keccak256(
                abi.encodePacked(block.prevrandao, block.timestamp, milestoneId, round, msg.sender, client, freelancer)
            )
        );

        uint256 start = seed % len;
        uint256 stride = (seed % (len - 1)) + 1; // 1..len-1, co-prime-friendly walk
        uint256 scanned;

        while (count < MAX_ARBITERS && scanned < len * POOL_SCAN) {
            uint256 idx = (start + scanned * stride) % len;
            address candidate = _rosterAt(idx);
            if (
                candidate != address(0) &&
                candidate != client &&
                candidate != freelancer &&
                !_alreadyPicked(picked, count, candidate) &&
                _isEligible(candidate)
            ) {
                picked[count] = candidate;
                count++;
            }
            scanned++;
        }
        return count;
    }

    function _alreadyPicked(address[3] memory picked, uint8 count, address candidate) private pure returns (bool) {
        for (uint8 i = 0; i < count; i++) {
            if (picked[i] == candidate) return true;
        }
        return false;
    }

    function _isEligible(address candidate) private view returns (bool) {
        // The registry exposes `isEligible`; guard the low-level call so a broken
        // registry cannot brick dispute opening (treated as not-eligible).
        (bool ok, bytes memory data) = address(arbiterRegistry).staticcall(
            abi.encodeWithSelector(IArbiterRegistry.isEligible.selector, candidate)
        );
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Commit–reveal voting
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Commit a hidden vote: `keccak256(abi.encode(outcome, salt, msg.sender, milestoneId, round))`.
     * @dev    Committing binds the arbiter; the reveal must match exactly.
     */
    function commitVote(uint256 milestoneId, uint8 round, bytes32 commitHash) external {
        Round storage r = _round(milestoneId, round);
        address arbiter = _msgSender();
        if (r.resolved) revert ArbitrationAlreadyResolved();
        if (!_isSelected(r, arbiter)) revert NotSelectedArbiter();
        if (block.timestamp > r.commitDeadline) revert CommitDeadlinePassed();
        if (r.commits[arbiter] != bytes32(0)) revert AlreadyCommitted();

        r.commits[arbiter] = commitHash;
        r.commitCount += 1;
        emit VoteCommitted(milestoneId, round, arbiter, commitHash);
    }

    /**
     * @notice Reveal a committed vote. Only valid after the commit deadline (so
     *         nobody can copy another's reveal) and before the reveal deadline.
     */
    function revealVote(uint256 milestoneId, uint8 round, uint8 outcome, bytes32 salt) external {
        Round storage r = _round(milestoneId, round);
        address arbiter = _msgSender();
        if (r.resolved) revert ArbitrationAlreadyResolved();
        if (!_isSelected(r, arbiter)) revert NotSelectedArbiter();
        if (block.timestamp <= r.commitDeadline) revert CommitDeadlineNotPassed();
        if (block.timestamp > r.revealDeadline) revert RevealWindowClosed();
        if (r.revealed[arbiter]) revert AlreadyRevealed();
        if (outcome > uint8(Outcome.Split)) revert InvalidOutcome(outcome);

        bytes32 expected = keccak256(abi.encode(outcome, salt, arbiter, milestoneId, round));
        if (r.commits[arbiter] != expected) revert CommitMismatch();

        r.revealed[arbiter] = true;
        r.votes[arbiter] = outcome;
        r.revealCount += 1;
        r.tally[outcome] += 1;

        emit VoteRevealed(milestoneId, round, arbiter, outcome);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolution
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Permissionless tally after the reveal deadline. Records the
     *         majority outcome for the round and marks it resolved, but does NOT
     *         move money yet — a party may still appeal within `appealWindow`.
     * @dev    Reverts while the reveal window is still open unless every selected
     *         arbiter has already revealed (early tally). A round that cannot
     *         reach quorum is settled immediately by the refund fallback.
     */
    function resolveDispute(uint256 milestoneId) external nonReentrant {
        Dispute storage d = disputes_[milestoneId];
        if (d.openedAt == 0) revert NotDisputed();
        Milestone storage m = _m(milestoneId);
        if (m.status != Status.Disputed) revert NotDisputed();

        uint8 round = d.round;
        Round storage r = rounds_[milestoneId][round];
        if (r.resolved) revert ArbitrationAlreadyResolved();
        if (block.timestamp <= r.revealDeadline && r.revealCount < r.arbiterCount) {
            revert RevealWindowOpen();
        }

        _tally(milestoneId, m, d, r, round);
    }

    /**
     * @notice Execute the decision once the appeal window has lapsed. Permissionless.
     * @dev    Separated from `resolveDispute` so an appeal can supersede a round
     *         before any money moves. Only the latest resolved round's outcome is
     *         ever paid, so the milestone settles exactly once.
     */
    function finalizeDispute(uint256 milestoneId) external nonReentrant {
        Dispute storage d = disputes_[milestoneId];
        if (d.openedAt == 0) revert NotDisputed();
        Milestone storage m = _m(milestoneId);
        if (m.status != Status.Disputed) revert NotDisputed();

        uint8 round = d.round;
        Round storage r = rounds_[milestoneId][round];
        if (!r.resolved) revert WrongPhase(Phase.Reveal, Phase.Commit);
        if (block.timestamp <= r.revealDeadline + appealWindow) revert AppealWindowOpen();

        uint8 winner = r.winningOutcome;

        // ── Money movement + rewards (the milestone settles exactly once) ─────
        _settleMilestone(milestoneId, m, winner);
        emit DisputeResolved(milestoneId, msg.sender, winner);
        _distributeRewards(milestoneId, d, r, winner);
        _releaseActive(r.arbiters, r.arbiterCount);
    }

    /**
     * @dev Tally a round's reveals, record the winning outcome and the majority
     *      arbiters, and either (quorum) await finalization or (no quorum) settle
     *      the refund fallback immediately.
     */
    function _tally(uint256 milestoneId, Milestone storage m, Dispute storage d, Round storage r, uint8 round) private {
        r.resolved = true;
        uint8 reveals = r.revealCount;

        // ── No-quorum fallback: refund the opener, back to Submitted ──────────
        if (reveals < QUORUM) {
            r.winningOutcome = uint8(Outcome.Refund);
            _releaseActive(r.arbiters, r.arbiterCount);
            uint256 refund = d.fee;
            if (refund > 0) _pay(d.openedBy, refund);
            emit DisputeFinalized(milestoneId, round, uint8(Outcome.Refund), reveals, false);
            emit NoQuorumFallback(milestoneId, d.openedBy, refund);
            m.status = Status.Submitted; // parties may retry / approve directly
            return;
        }

        // ── Majority tally (ties resolve to Split for fairness) ───────────────
        uint8 winner = _winningOutcome(r.tally);
        r.winningOutcome = winner;
        d.settledOutcome = winner;
        d.settledArbiters = r.arbiters;

        emit DisputeFinalized(milestoneId, round, winner, reveals, true);
    }

    /// @dev Apply the winning outcome to the milestone and push payments.
    function _settleMilestone(uint256 milestoneId, Milestone storage m, uint8 winner) private {
        if (winner == uint8(Outcome.Release)) {
            m.status = Status.ResolvedRelease;
            uint256 fee = _feeOn(m.amount, m.feeBps);
            uint256 principal = m.amount - fee;
            accruedFees += fee;
            emit MilestoneReleased(milestoneId, m.freelancer, principal, fee, true);
            _pay(m.freelancer, principal);
        } else if (winner == uint8(Outcome.Refund)) {
            m.status = Status.ResolvedRefund;
            emit MilestoneRefunded(milestoneId, m.client, m.amount, true);
            _pay(m.client, m.amount);
        } else {
            m.status = Status.ResolvedSplit;
            uint256 half = m.amount / 2;
            uint256 fee = _feeOn(half, m.feeBps);
            uint256 freelancerAmount = half - fee;
            uint256 clientAmount = m.amount - half;
            accruedFees += fee;
            emit MilestoneSplit(milestoneId, clientAmount, freelancerAmount, fee);
            _pay(m.freelancer, freelancerAmount);
            _pay(m.client, clientAmount);
        }
    }

    /**
     * @dev Majority arbiters split the reward pot proportionally to the stake
     *      snapshot captured at selection; minority arbiters take −10;
     *      non-revealers take −15.
     *
     *      Reward_i = pot × weight_i / Σ weight_majority, where weight_i is the
     *      arbiter's staked collateral at the time they were drawn. Rounding
     *      dust is retained in rewardPool rather than lost (same policy as the
     *      former flat split).
     */
    function _distributeRewards(uint256 milestoneId, Dispute storage d, Round storage r, uint8 winner) private {
        // Pass 1 — total stake weight of the winning (revealed-majority) set.
        uint256 totalWeight;
        for (uint8 i = 0; i < r.arbiterCount; i++) {
            address a = r.arbiters[i];
            if (r.revealed[a] && r.votes[a] == winner) totalWeight += r.stakeWeights[a];
        }
        if (totalWeight == 0) totalWeight = 1; // defensive; cannot happen with quorum

        // Reward pot = dispute fee. Distributed pro-rata by stake weight; any
        // rounding dust stays in the contract (tracked by rewardPool).
        uint256 pot = d.fee;
        uint256 used;

        // Pass 2 — apply score changes and pay each arbiter its weighted share.
        for (uint8 i = 0; i < r.arbiterCount; i++) {
            address a = r.arbiters[i];
            if (!_isRegistered(a)) continue;

            if (r.revealed[a] && r.votes[a] == winner) {
                arbiterRegistry.applyScoreChange(a, int256(_deltaMajority()), _reasonMajority());
                uint256 amount = (pot * r.stakeWeights[a]) / totalWeight;
                if (amount > 0) {
                    used += amount;
                    emit ArbiterRewarded(milestoneId, a, amount);
                    _pay(a, amount);
                }
            } else if (!r.revealed[a]) {
                arbiterRegistry.applyScoreChange(a, int256(_deltaMissed()), _reasonMissed());
                emit ArbiterPenalized(milestoneId, a, _reasonMissed());
            } else {
                arbiterRegistry.applyScoreChange(a, int256(_deltaMinority()), _reasonMinority());
                emit ArbiterPenalized(milestoneId, a, _reasonMinority());
            }
        }

        uint256 dust = pot - used;
        if (dust > 0) rewardPool += dust;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Appeals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice A party appeals a settled decision within `appealWindow`, paying a
     *         further dispute fee. A fresh round of (re-selected) arbiters runs;
     *         if the result differs from the original, the original majority is
     *         penalised −25 each (REASON_OVERTURNED).
     * @dev    The milestone stays Disputed across an appeal; the appeal round
     *         re-runs commit → reveal → resolve.
     */
    function appeal(uint256 milestoneId) external payable nonReentrant {
        Dispute storage d = disputes_[milestoneId];
        if (d.openedAt == 0) revert NotDisputed();
        Milestone storage m = _m(milestoneId);
        address appellant = _msgSender();
        if (appellant != m.client && appellant != m.freelancer) revert NotParty();
        if (msg.value < disputeFee) revert DisputeFeeTooLow(msg.value, disputeFee);

        uint8 prevRound = d.round;
        Round storage pr = rounds_[milestoneId][prevRound];
        if (!pr.resolved) revert WrongPhase(Phase.Reveal, Phase.Commit);
        if (block.timestamp > pr.revealDeadline + appealWindow) revert AppealWindowClosed();

        uint8 newRound = prevRound + 1;
        d.round = newRound;
        d.appealCount += 1;
        d.fee = msg.value; // appeal fee becomes the new reward pot

        emit AppealOpened(milestoneId, newRound, appellant, msg.value);
        _startRound(milestoneId, m, newRound);
    }

    /**
     * @notice Tally an appeal round and, when the new majority differs from the
     *         round it replaced, penalise the previous majority −25 each
     *         (REASON_OVERTURNED). Payout still happens later via
     *         `finalizeDispute` so further appeals remain possible.
     */
    function resolveAppeal(uint256 milestoneId) external nonReentrant {
        Dispute storage d = disputes_[milestoneId];
        if (d.openedAt == 0) revert NotDisputed();
        Milestone storage m = _m(milestoneId);
        if (m.status != Status.Disputed) revert NotDisputed();

        uint8 round = d.round;
        if (round == 0) revert AppealAlreadyOpen();
        Round storage r = rounds_[milestoneId][round];
        if (r.resolved) revert ArbitrationAlreadyResolved();
        if (block.timestamp <= r.revealDeadline && r.revealCount < r.arbiterCount) revert RevealWindowOpen();

        uint8 prevOutcome = d.settledOutcome;
        address[3] memory prevMajority = d.settledArbiters;

        _tally(milestoneId, m, d, r, round);

        // Only a quorum decision can overturn; a no-quorum appeal falls back and
        // returns the milestone to Submitted (no overturn to score).
        if (m.status == Status.Disputed && r.revealCount >= QUORUM) {
            bool overturned = r.winningOutcome != prevOutcome;
            emit AppealResolved(milestoneId, round, overturned);
            if (overturned) {
                for (uint8 i = 0; i < MAX_ARBITERS; i++) {
                    address a = prevMajority[i];
                    if (a != address(0) && _isRegistered(a)) {
                        arbiterRegistry.applyScoreChange(a, int256(_deltaOverturned()), _reasonOverturned());
                        emit ArbiterPenalized(milestoneId, a, _reasonOverturned());
                    }
                }
            }
        } else {
            emit AppealResolved(milestoneId, round, false);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees & admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Withdraw accrued platform fees. Zero-amount withdrawals revert.
    function withdrawFees(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = accruedFees;
        if (amount == 0) revert NothingToWithdraw();

        accruedFees = 0; // EFFECT before INTERACTION (CEI)
        emit FeeWithdrawn(to, amount);
        _pay(to, amount);
    }

    /// @notice Set the platform fee for FUTURE milestones (capped at 5%).
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        uint16 old = feeBps;
        feeBps = newFeeBps;
        emit PlatformFeeUpdated(old, newFeeBps);
    }

    /// @notice Set the dispute fee for FUTURE disputes.
    function setDisputeFee(uint256 newFee) external onlyOwner {
        uint256 old = disputeFee;
        disputeFee = newFee;
        emit DisputeFeeUpdated(old, newFee);
    }

    /**
     * @notice Repoint the trusted ERC-2771 forwarder (gasless meta-tx sponsor).
     *         Owner-gated (timelock in prod); address(0) disables forwarding.
     */
    function setTrustedForwarder(address forwarder_) external onlyOwner {
        _setTrustedForwarder(forwarder_);
    }

    /// @notice Fund the reward pool used to top up arbiter rewards.
    function depositRewards() external payable {
        if (msg.value == 0) revert ZeroAmount();
        rewardPool += msg.value;
        emit RewardsDeposited(msg.sender, msg.value);
    }

    /// @notice Withdraw leftover reward dust to the treasury (owner-gated).
    function sweepRewardPool() external onlyOwner nonReentrant {
        uint256 amount = rewardPool;
        if (amount == 0) revert NothingToWithdraw();
        rewardPool = 0;
        _pay(treasury, amount);
    }

    /// @notice Repoint the arbiter registry. Owner-gated (timelocked in prod).
    function setArbiterRegistry(IArbiterRegistry newRegistry) external onlyOwner {
        if (address(newRegistry) == address(0)) revert ZeroAddress();
        arbiterRegistry = newRegistry;
    }

    /// @notice Set the treasury that receives slashed/undistributed funds.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The status the backend re-derives truth from. Unknown ids revert.
    function milestoneStatus(uint256 milestoneId) external view returns (Status) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId].status;
    }

    function getMilestone(uint256 milestoneId) external view returns (Milestone memory) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId];
    }

    /// @notice Dispute metadata (opener, fee, current round, appeal count).
    function getDispute(uint256 milestoneId) external view returns (Dispute memory) {
        return disputes_[milestoneId];
    }

    /// @notice Public view of a round's selected arbiters and phase-relevant data.
    function getRound(uint256 milestoneId, uint8 round)
        external
        view
        returns (
            address[3] memory arbiters,
            uint8 arbiterCount,
            uint8 commitCount,
            uint8 revealCount,
            uint8[3] memory tally,
            uint64 commitDeadline,
            uint64 revealDeadline,
            bool resolved,
            uint8 winningOutcome
        )
    {
        Round storage r = rounds_[milestoneId][round];
        return (
            r.arbiters,
            r.arbiterCount,
            r.commitCount,
            r.revealCount,
            r.tally,
            r.commitDeadline,
            r.revealDeadline,
            r.resolved,
            r.winningOutcome
        );
    }

    /// @notice The commit hash an arbiter must submit for a given vote.
    function computeCommit(uint256 milestoneId, uint8 round, uint8 outcome, bytes32 salt, address arbiter)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(outcome, salt, arbiter, milestoneId, round));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Upgrade authorization
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Only the owner (a TimelockController in production) may upgrade.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _m(uint256 milestoneId) private view returns (Milestone storage) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId];
    }

    function _round(uint256 milestoneId, uint8 round) private view returns (Round storage) {
        Dispute storage d = disputes_[milestoneId];
        if (d.openedAt == 0 || round != d.round) revert NotDisputed();
        return rounds_[milestoneId][round];
    }

    function _isSelected(Round storage r, address a) private view returns (bool) {
        for (uint8 i = 0; i < r.arbiterCount; i++) {
            if (r.arbiters[i] == a) return true;
        }
        return false;
    }

    /// @dev Highest tally wins; a tie resolves to Split (index 2) for fairness.
    function _winningOutcome(uint8[3] memory tally) private pure returns (uint8) {
        uint8 best = 0;
        for (uint8 i = 1; i < 3; i++) {
            if (tally[i] > tally[best]) best = i;
        }
        // tie detection
        uint8 bestCount = 0;
        for (uint8 i = 0; i < 3; i++) {
            if (tally[i] == tally[best]) bestCount++;
        }
        if (bestCount > 1) return uint8(Outcome.Split);
        return best;
    }

    /// @dev Decrement in-flight counters for a round's arbiters once the dispute
    ///      is fully over, so the registry stops treating them as busy.
    function _releaseActive(address[3] memory arbiters, uint8 count) private {
        for (uint8 i = 0; i < count; i++) {
            if (arbiters[i] != address(0) && activeDisputes[arbiters[i]] > 0) {
                activeDisputes[arbiters[i]] -= 1;
            }
        }
    }

    function _isRegistered(address a) private view returns (bool) {
        (bool ok, bytes memory data) =
            address(arbiterRegistry).staticcall(abi.encodeWithSelector(IArbiterRegistry.isRegistered.selector, a));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    function _rosterLength() private view returns (uint256) {
        (bool ok, bytes memory data) =
            address(arbiterRegistry).staticcall(abi.encodeWithSelector(IArbiterRegistry.rosterLength.selector));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _rosterAt(uint256 index) private view returns (address) {
        (bool ok, bytes memory data) =
            address(arbiterRegistry).staticcall(abi.encodeWithSelector(IArbiterRegistry.rosterAt.selector, index));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    // ── Score delta/reason accessors (kept internal to avoid ABI coupling) ─────

    function _deltaMajority() private pure returns (int256) {
        return 5;
    }

    function _deltaMinority() private pure returns (int256) {
        return -10;
    }

    function _deltaMissed() private pure returns (int256) {
        return -15;
    }

    function _deltaOverturned() private pure returns (int256) {
        return -25;
    }

    function _reasonMajority() private pure returns (uint8) {
        return 1;
    }

    function _reasonMinority() private pure returns (uint8) {
        return 2;
    }

    function _reasonMissed() private pure returns (uint8) {
        return 3;
    }

    function _reasonOverturned() private pure returns (uint8) {
        return 4;
    }

    /// @dev Floor fee, identical to the backend's feeOf: principal * bps / 10_000.
    function _feeOn(uint256 principal, uint16 bps) private pure returns (uint256) {
        return (principal * bps) / 10_000;
    }

    /// @dev Push payment, always the LAST effect in a payout path (CEI).
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /// @dev Direct ETH transfers revert, so the balance maps 1:1 to liabilities.
    receive() external payable {
        revert("Escrow: direct transfers not allowed"); // solhint-disable-line reason-string
    }

    // ── ERC-2771 diamond resolution ──────────────────────────────────────────
    // Escrow inherits ContextUpgradeable via both Ownable2StepUpgradeable and
    // ERC2771ContextLite; these explicit overrides defer to the ERC-2771-aware
    // implementation (the most-derived virtual, i.e. ERC2771ContextLite).

    function _msgSender() internal view override(ERC2771ContextLite, ContextUpgradeable) returns (address) {
        return super._msgSender();
    }

    function _msgData() internal view override(ERC2771ContextLite, ContextUpgradeable) returns (bytes calldata) {
        return super._msgData();
    }

    function _contextSuffixLength() internal view override(ERC2771ContextLite, ContextUpgradeable) returns (uint256) {
        return super._contextSuffixLength();
    }
}
