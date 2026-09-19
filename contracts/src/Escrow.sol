// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IArbiterRegistry} from "./IArbiterRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Escrow — the money authority of OpenLance (PRD §7.2, F4/F5/F10)
 * @notice ONE contract holding every milestone (not a factory of per-project
 *         clones): dispute, arbiter, fee and settlement logic is cross-project,
 *         and a single accounting surface is what the invariant tests protect.
 *
 *         Milestone state machine (the backend mirrors this 1:1):
 *
 *                                            ┌── approve ──> Released
 *              fund      submit              │
 *   (off-chain) ──> Funded ──> Submitted ─────┤
 *                │      │                     │
 *                │      └──── dispute ──> Disputed ── resolve ──> ResolvedRelease
 *                │                                   │         ├─> ResolvedRefund
 *                └── cancel ──> Cancelled             │         └─> ResolvedSplit
 *                                                    └── slash (arbiter removed,
 *                                                         dispute stays open for
 *                                                         reassignment)
 *
 *         Native ETH only in the MVP (ERC-20 is upgrade Tier 3). Push payments
 *         with checks-effects-interactions + nonReentrant on every payout path
 *         (PRD §7.4).
 *
 * @dev The off-chain milestone uuid travels in `fund(ref, ...)` so the indexer
 *      maps on-chain ids back to rows deterministically — no (client,
 *      freelancer, amount) tuple matching. Event payloads are byte-for-byte the
 *      backend's expected surface (mini-services/api/src/chain/abi.ts); the
 *      topic hashes are locked by test/EventSurface.t.sol.
 */
contract Escrow is Ownable, ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────────────────
    // Types — Status ordinal positions are API: the backend maps uint8 → name
    // (ONCHAIN_MILESTONE_STATUS in src/chain/events.ts). Never reorder.
    // ─────────────────────────────────────────────────────────────────────────

    enum Status {
        PendingFunding, // 0 — off-chain only: a template row not yet funded
        Funded, // 1
        Submitted, // 2
        Disputed, // 3
        Released, // 4 — client approved
        ResolvedRelease, // 5 — arbiter ruled: release
        ResolvedRefund, // 6 — arbiter ruled: refund
        ResolvedSplit, // 7 — arbiter ruled: split
        Cancelled // 8 — client cancelled before submission (full refund)
    }

    enum Outcome {
        Release, // 0
        Refund, // 1
        Split // 2
    }

    struct Milestone {
        bytes32 ref; // off-chain milestone uuid, left-padded (indexer join key)
        address client; // funder
        address freelancer; // payee on release
        uint256 amount; // wei, immutable after funding
        uint16 feeBps; // platform fee snapshot at funding (in-flight changes never apply)
        Status status;
    }

    struct Dispute {
        address openedBy;
        uint64 openedAt;
        uint64 agreementDeadline; // openedAt + 48h — admin assignment unlocks after
        address arbiter; // zero until mutual nomination or admin assignment
        uint64 slaDeadline; // set at assignment; resolution SLA = 72h
        address clientNominee;
        address freelancerNominee;
    }

    // ── Indexer-facing events (names/args match src/chain/abi.ts exactly) ────

    event MilestoneFunded(uint256 indexed milestoneId, bytes32 indexed ref, address indexed client, address freelancer, uint256 amount);
    event MilestoneSubmitted(uint256 indexed milestoneId, address indexed freelancer);
    event MilestoneReleased(uint256 indexed milestoneId, address freelancer, uint256 principal, uint256 fee, bool viaDisputeResolution);
    event MilestoneRefunded(uint256 indexed milestoneId, address client, uint256 amount, bool viaDisputeResolution);
    event MilestoneSplit(uint256 indexed milestoneId, uint256 clientAmount, uint256 freelancerAmount, uint256 fee);
    event MilestoneCancelled(uint256 indexed milestoneId, address client, uint256 amount);
    event DisputeOpened(uint256 indexed milestoneId, address by, uint256 lockedAmount);
    event DisputeResolved(uint256 indexed milestoneId, address indexed arbiter, uint8 outcome);
    event FeeWithdrawn(address indexed to, uint256 amount);

    // ── Admin/ops events (not consumed by the indexer) ────────────────────────

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
    error ArbiterAlreadyAssigned(address arbiter);
    error NoArbiterAssigned();
    error NotAssignedArbiter();
    error ArbiterNotRegistered(address arbiter);
    error AgreementWindowOpen(uint64 until);
    error SlashWindowNotOpen(uint64 opensAt);
    error InvalidOutcome(uint8 outcome);
    error FeeTooHigh(uint16 requested, uint16 max);
    error NothingToWithdraw();
    error TransferFailed();

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice Arbiter identity + SLA trust records (owned by the platform, driven by disputes).
    IArbiterRegistry public immutable arbiterRegistry;

    /// @notice Platform fee in basis points, applied to RELEASED value only.
    uint16 public feeBps = 250; // 2.5% (PRD default)

    /// @notice Hard cap on the admin fee lever.
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice Dispute coordination windows (PRD F10/F12).
    uint64 public constant ARBITER_AGREEMENT_WINDOW = 48 hours;
    uint64 public constant RESOLUTION_SLA = 72 hours;
    uint64 public constant SLASH_GRACE = 24 hours;

    mapping(uint256 => Milestone) private milestones_;
    mapping(uint256 => Dispute) private disputes_; // keyed by milestoneId
    uint256 public nextMilestoneId = 1; // id 0 is never used
    uint256 public accruedFees; // unwithdrawn platform fees (part of the solvency invariant)

    constructor(IArbiterRegistry arbiterRegistry_, address owner_) Ownable(owner_) {
        if (address(arbiterRegistry_) == address(0)) revert ZeroAddress();
        arbiterRegistry = arbiterRegistry_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Funding
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Fund a milestone: the client escrows `msg.value` for `freelancer`.
     *         `ref` is the off-chain milestone uuid (left-padded to bytes32) —
     *         the indexer's deterministic join key.
     * @dev    No reentrancy guard needed: no external calls happen here.
     */
    function fund(bytes32 ref, address freelancer) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (freelancer == address(0) || freelancer == msg.sender) revert InvalidFreelancer();

        uint256 milestoneId = nextMilestoneId++;
        Milestone storage m = milestones_[milestoneId];
        m.ref = ref;
        m.client = msg.sender;
        m.freelancer = freelancer;
        m.amount = msg.value;
        m.feeBps = feeBps; // snapshot: later fee changes never touch in-flight milestones
        m.status = Status.Funded;

        emit MilestoneFunded(milestoneId, ref, msg.sender, freelancer, msg.value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy path
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Freelancer signals work is delivered (off-chain notes + files
    ///         live in the backend; this is the on-chain commitment).
    function submit(uint256 milestoneId) external {
        Milestone storage m = _m(milestoneId);
        if (msg.sender != m.freelancer) revert NotFreelancer();
        if (m.status != Status.Funded) revert WrongStatus(Status.Funded, m.status);

        m.status = Status.Submitted;
        emit MilestoneSubmitted(milestoneId, m.freelancer);
    }

    /// @notice Client approves delivered work: fee is taken, principal released.
    function approve(uint256 milestoneId) external nonReentrant {
        Milestone storage m = _m(milestoneId);
        if (msg.sender != m.client) revert NotClient();
        if (m.status != Status.Submitted) revert WrongStatus(Status.Submitted, m.status);

        m.status = Status.Released;
        uint256 fee = _feeOn(m.amount, m.feeBps);
        uint256 principal = m.amount - fee;
        accruedFees += fee;

        emit MilestoneReleased(milestoneId, m.freelancer, principal, fee, false);
        _pay(m.freelancer, principal);
    }

    /// @notice Client cancels a funded (not yet submitted) milestone: full refund.
    function cancel(uint256 milestoneId) external nonReentrant {
        Milestone storage m = _m(milestoneId);
        if (msg.sender != m.client) revert NotClient();
        if (m.status != Status.Funded) revert WrongStatus(Status.Funded, m.status);

        m.status = Status.Cancelled;
        emit MilestoneCancelled(milestoneId, m.client, m.amount);
        _pay(m.client, m.amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Disputes
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Either party locks a funded/submitted milestone into dispute.
    ///         Funds stay escrowed until an arbiter resolves.
    function openDispute(uint256 milestoneId) external {
        Milestone storage m = _m(milestoneId);
        if (msg.sender != m.client && msg.sender != m.freelancer) revert NotParty();
        if (m.status != Status.Funded && m.status != Status.Submitted) revert NotDisputable(m.status);

        m.status = Status.Disputed;
        Dispute storage d = disputes_[milestoneId];
        d.openedBy = msg.sender;
        d.openedAt = uint64(block.timestamp);
        d.agreementDeadline = uint64(block.timestamp) + ARBITER_AGREEMENT_WINDOW;

        emit DisputeOpened(milestoneId, msg.sender, m.amount);
    }

    /**
     * @notice A party nominates a registered arbiter. The moment BOTH parties
     *         nominate the same address, the arbiter is assigned and the 72h
     *         resolution SLA clock starts. Trust-minimized: no platform
     *         involvement needed when parties cooperate.
     */
    function nominateArbiter(uint256 milestoneId, address candidate) external {
        Milestone storage m = _m(milestoneId);
        Dispute storage d = disputes_[milestoneId];
        if (m.status != Status.Disputed) revert NotDisputed();
        if (msg.sender != m.client && msg.sender != m.freelancer) revert NotParty();
        if (d.arbiter != address(0)) revert ArbiterAlreadyAssigned(d.arbiter);
        if (!arbiterRegistry.isRegistered(candidate)) revert ArbiterNotRegistered(candidate);

        if (msg.sender == m.client) {
            d.clientNominee = candidate;
            if (d.freelancerNominee == candidate) _assign(d, candidate);
        } else {
            d.freelancerNominee = candidate;
            if (d.clientNominee == candidate) _assign(d, candidate);
        }
    }

    /**
     * @notice Platform fallback: assign an arbiter once the 48h mutual-agreement
     *         window has lapsed without agreement (PRD F10).
     */
    function adminAssignArbiter(uint256 milestoneId, address arbiter) external onlyOwner {
        Milestone storage m = _m(milestoneId);
        Dispute storage d = disputes_[milestoneId];
        if (m.status != Status.Disputed) revert NotDisputed();
        if (d.arbiter != address(0)) revert ArbiterAlreadyAssigned(d.arbiter);
        if (uint64(block.timestamp) < d.agreementDeadline) revert AgreementWindowOpen(d.agreementDeadline);
        if (!arbiterRegistry.isRegistered(arbiter)) revert ArbiterNotRegistered(arbiter);

        _assign(d, arbiter);
    }

    /**
     * @notice The assigned arbiter rules on a disputed milestone and the
     *         contract executes the payout in the same transaction:
     *
     *           Release → fee on the full amount, principal to the freelancer
     *           Refund  → full amount to the client, no fee
     *           Split   → 50/50; fee applies to the released (freelancer) half only;
     *                     odd wei rounds to the client (conservation is exact)
     *
     *         Event order is load-bearing (the backend mock guarantees the same
     *         sequence): DisputeResolved → settlement event → TrustScoreUpdated.
     */
    function resolveDispute(uint256 milestoneId, uint8 outcome) external nonReentrant {
        Milestone storage m = _m(milestoneId);
        Dispute storage d = disputes_[milestoneId];
        if (m.status != Status.Disputed) revert NotDisputed();
        if (d.arbiter == address(0)) revert NoArbiterAssigned();
        if (msg.sender != d.arbiter) revert NotAssignedArbiter();

        bool withinSla = block.timestamp <= d.slaDeadline;
        address arbiter = d.arbiter;

        emit DisputeResolved(milestoneId, arbiter, outcome);

        if (outcome == uint8(Outcome.Release)) {
            m.status = Status.ResolvedRelease;
            uint256 fee = _feeOn(m.amount, m.feeBps);
            uint256 principal = m.amount - fee;
            accruedFees += fee;
            emit MilestoneReleased(milestoneId, m.freelancer, principal, fee, true);
            _pay(m.freelancer, principal);
        } else if (outcome == uint8(Outcome.Refund)) {
            m.status = Status.ResolvedRefund;
            emit MilestoneRefunded(milestoneId, m.client, m.amount, true);
            _pay(m.client, m.amount);
        } else if (outcome == uint8(Outcome.Split)) {
            m.status = Status.ResolvedSplit;
            uint256 half = m.amount / 2;
            uint256 fee = _feeOn(half, m.feeBps);
            uint256 freelancerAmount = half - fee;
            uint256 clientAmount = m.amount - half;
            accruedFees += fee;
            emit MilestoneSplit(milestoneId, clientAmount, freelancerAmount, fee);
            _pay(m.freelancer, freelancerAmount);
            _pay(m.client, clientAmount);
        } else {
            revert InvalidOutcome(outcome);
        }

        // SLA accounting. If the arbiter was deregistered after assignment
        // (e.g. platform removal), there is no live score to update — skipping
        // keeps resolution possible and the mirror consistent (no event, no bump).
        if (arbiterRegistry.isRegistered(arbiter)) {
            arbiterRegistry.recordResolution(arbiter, withinSla);
        }
    }

    /**
     * @notice Anyone may slash an arbiter who failed to resolve within the SLA
     *         plus a 24h grace period. The arbiter is deregistered; the dispute
     *         stays open and can be reassigned (admin path is always unlocked
     *         by now — the 48h window has long passed).
     */
    function slashStaleArbiter(uint256 milestoneId) external {
        Milestone storage m = _m(milestoneId);
        Dispute storage d = disputes_[milestoneId];
        if (m.status != Status.Disputed) revert NotDisputed();
        if (d.arbiter == address(0)) revert NoArbiterAssigned();
        if (block.timestamp <= uint256(d.slaDeadline) + SLASH_GRACE) {
            revert SlashWindowNotOpen(uint64(d.slaDeadline + SLASH_GRACE));
        }

        address stale = d.arbiter;
        d.arbiter = address(0);
        d.slaDeadline = 0;

        arbiterRegistry.slash(stale); // emits ArbiterDeregistered on the registry
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees & admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Withdraw accrued platform fees. Zero-amount withdrawals revert.
    function withdrawFees(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = accruedFees;
        if (amount == 0) revert NothingToWithdraw();

        accruedFees = 0;
        emit FeeWithdrawn(to, amount);
        _pay(to, amount);
    }

    /// @notice Set the platform fee for FUTURE milestones (capped at 5%).
    ///         In-flight milestones keep their funding-time snapshot.
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        uint16 old = feeBps;
        feeBps = newFeeBps;
        emit PlatformFeeUpdated(old, newFeeBps);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views — the backend's RPC surface
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice The status the backend re-derives truth from (review gating,
     *         reconciliation). Unknown ids revert — the backend treats a
     *         reverting read as "unreachable", never as a status.
     */
    function milestoneStatus(uint256 milestoneId) external view returns (Status) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId].status;
    }

    function getMilestone(uint256 milestoneId) external view returns (Milestone memory) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId];
    }

    function getDispute(uint256 milestoneId) external view returns (Dispute memory) {
        return disputes_[milestoneId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _m(uint256 milestoneId) private view returns (Milestone storage) {
        if (milestoneId == 0 || milestoneId >= nextMilestoneId) revert UnknownMilestone(milestoneId);
        return milestones_[milestoneId];
    }

    function _assign(Dispute storage d, address arbiter) private {
        d.arbiter = arbiter;
        d.slaDeadline = uint64(block.timestamp) + RESOLUTION_SLA;
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

    /// @dev Milestones settle at most once; solvency is asserted by the
    ///      invariant suite (balance ≥ Σ unsettled amounts + accrued fees).
    receive() external payable {
        revert("Escrow: direct transfers not allowed"); // solhint-disable-line reason-string
    }
}
