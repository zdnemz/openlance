// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IArbiterRegistry} from "./IArbiterRegistry.sol";

/**
 * @title ArbiterRegistry — staked arbiter identity + on-chain trust
 * @notice Everything about *who may arbitrate* lives here: an ETH-collateralised
 *         roster with a 0–100 trust score. The Escrow contract owns the dispute
 *         lifecycle and calls back into this registry to score arbiters and to
 *         slash them.
 *
 *         ══════════════════════ Staking model ══════════════════════
 *           - registerArbiter() {value: >= MIN_STAKE} → joins the roster, score 100.
 *           - requestUnstake() requires the stake to have aged at least
 *             `unstakeCooldown` seconds (no join-and-leave sniping); it
 *             benches the arbiter from selection immediately.
 *           - withdrawStake() pays out IMMEDIATELY once requested (no second
 *             wait) — provided the score is still >= MIN_SCORE_TO_WITHDRAW.
 *           - Score  < n  → the stake is LOCKED: requestUnstake() reverts and the
 *             arbiter is dropped from the selection pool (cannot be picked for
 *             new disputes) until the score recovers.
 *           - Score == 0  → the stake is SLASHED in full to the treasury and the
 *             arbiter is removed from the roster.
 *
 *         ══════════════════════ Trust score ══════════════════════
 *           MAX_SCORE = 100 (new arbiters start here).
 *           vote with majority        +5   (REASON_MAJORITY)
 *           vote with minority        −10  (REASON_MINORITY)
 *           missed deadline           −15  (REASON_MISSED)
 *           decision overturned       −25  (REASON_OVERTURNED)
 *           ScoreChanged(arbiter, oldScore, newScore, reason) is emitted on
 *           every mutation.
 *
 * @dev UPGRADEABLE (UUPS), owner = TimelockController in production.
 *
 *      SECURITY:
 *       - ReentrancyGuardTransient + CEI on withdrawStake (the only ETH exit).
 *       - Scores are mutated ONLY by the escrow (onlyEscrow) — no self-scoring.
 *       - Stake/slash/treasury changes are owner-gated (timelock in prod).
 *       - A locked arbiter cannot withdraw, so misbehaviour has real skin.
 */
contract ArbiterRegistry is IArbiterRegistry, ERC721Upgradeable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient {
    // ── Immutable score constants (part of the public contract) ────────────────
    uint256 public constant MAX_SCORE = 100;
    int256 public constant DELTA_MAJORITY = 5; // voted with the majority
    int256 public constant DELTA_MINORITY = -10; // voted with the minority
    int256 public constant DELTA_MISSED = -15; // failed to meet the deadline
    int256 public constant DELTA_OVERTURNED = -25; // decision overturned on appeal

    // ── Score-change reasons (mirrored off-chain, keep the mapping stable) ─────
    uint8 public constant REASON_MAJORITY = 1;
    uint8 public constant REASON_MINORITY = 2;
    uint8 public constant REASON_MISSED = 3;
    uint8 public constant REASON_OVERTURNED = 4;
    uint8 public constant REASON_RECOVERY = 5; // reserved for future use

    // ── Indexer-facing events ──────────────────────────────────────────────────
    event ArbiterRegistered(address indexed arbiter, uint256 sbtTokenId);
    event ArbiterDeregistered(address indexed arbiter);
    event TrustScoreUpdated(address indexed arbiter, int256 delta, uint256 newScore, bool withinSla);

    /// @notice Spec event: emitted on every trust-score mutation.
    event ScoreChanged(address indexed arbiter, uint256 oldScore, uint256 newScore, uint8 reason);

    event StakeDeposited(address indexed arbiter, uint256 amount, uint256 totalStake);
    event StakeLocked(address indexed arbiter, uint256 amount, uint256 score); // score < MIN_SCORE_TO_WITHDRAW
    event UnstakeRequested(address indexed arbiter, uint256 amount);
    event UnstakeCancelled(address indexed arbiter);
    event StakeWithdrawn(address indexed arbiter, uint256 amount);
    event StakeSlashed(address indexed arbiter, address indexed treasury, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MinStakeUpdated(uint256 oldMinStake, uint256 newMinStake);
    event TierThresholdsUpdated(uint256 silverStake, uint256 goldStake);
    event MinScoreToWithdrawUpdated(uint256 oldScore, uint256 newScore);
    event MinStakeDurationUpdated(uint256 oldSeconds, uint256 newSeconds);
    event UnstakeCooldownUpdated(uint256 oldSeconds, uint256 newSeconds);

    // ── Admin/ops events ───────────────────────────────────────────────────────
    event EscrowSet(address indexed escrow);

    // ── ERC-5194: Minimal Soulbound NFTs ───────────────────────────────────────
    event Locked(uint256 indexed tokenId);
    event Unlocked(uint256 indexed tokenId); // never emitted: badges are born locked, forever

    struct ArbiterInfo {
        bool registered;
        bool unstakeRequested;
        uint256 tokenId; // latest SBT (re-registration mints a fresh one)
        uint256 trustScore;
        uint256 stake; // wei currently deposited as collateral
        uint256 resolutions;
        uint256 stakedAt; // when the current continuous stake began (min-stake-duration clock)
        uint256 unstakeRequestedAt; // when requestUnstake was called (record only)
    }

    // ── Errors ─────────────────────────────────────────────────────────────────
    error NotEscrow();
    error NotAuthorized();
    error ZeroAddress();
    error AlreadyRegistered(address arbiter);
    error NotRegistered(address arbiter);
    error EscrowAlreadySet(address current);
    error NonTransferable(uint256 tokenId);
    error StakeBelowMinimum(uint256 provided, uint256 minStake);
    error AlreadyStaked(uint256 currentStake);
    error NoStake();
    error StakeIsLocked(uint256 score, uint256 minScore);
    error UnstakeNotRequested();
    error UnstakeAlreadyRequested();
    error StillHandlingDispute(address arbiter);
    error TransferFailed();
    error BadTierThresholds(uint256 silver, uint256 gold, uint256 minStake);
    /// @notice Selection blocked: not staked for at least `minStakeDuration` yet.
    error StakeTooRecent(uint256 stakedAt, uint256 minStakeDuration);
    /// @notice Exit blocked: the stake hasn't aged `unstakeCooldown` yet.
    error UnstakeTooEarly(uint256 readyAt);
    /// @notice Withdrawal blocked: the `unstakeCooldown` has not elapsed yet.
    error UnstakeCooldownActive(uint256 readyAt);

    /// @notice The escrow contract allowed to score/slash. Set once.
    address public escrow;
    uint256 public nextTokenId;
    mapping(address => ArbiterInfo) internal arbiters;

    /// @notice Enumerable roster of currently-registered arbiters (append/swap-remove),
    ///         so the escrow can draw candidates without off-chain input.
    address[] internal roster;
    mapping(address => uint256) internal rosterIndex; // arbiter => 1-based index into roster (0 = absent)

    /// @notice Minimum ETH collateral to join / stay on the roster.
    uint256 public minStake;
    /// @notice Below this trust score the stake is locked and the arbiter is benched.
    uint256 public minScoreToWithdraw;
    /// @notice Receives slashed collateral.
    address public treasury;
    /// @notice Minimum continuous stake time (seconds) before an arbiter may be
    ///         selected for a new dispute — blocks join-and-leave sniping.
    uint256 public minStakeDuration;
    /// @notice Minimum staking time (seconds) before `requestUnstake` may be
    ///         called — the exit cooldown gates the REQUEST, not the payout:
    ///         once requested, `withdrawStake` releases immediately.
    uint256 public unstakeCooldown;
    /// @notice Tier floors (wei): bronze = minStake, silver/gold upgrade selection
    ///         weight + fee share. Invariant: minStake <= tierSilver <= tierGold.
    uint256 public tierSilver;
    uint256 public tierGold;

    /// @dev Reserved storage for future upgrades. Shrink only by the number of
    ///      slots added above it.
    uint256[36] private __gap;

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy atomically.
     * @param name_               SBT collection name
     * @param symbol_             SBT collection symbol
     * @param owner_              upgrade/admin authority (TimelockController in prod)
     * @param minStake_           minimum collateral in wei (e.g. 0.1 ether)
     * @param minScoreToWithdraw_ score threshold n below which the stake locks
     * @param treasury_           receives slashed collateral (defaults to owner if zero)
     * @param minStakeDuration_   seconds of continuous stake required before selection
     * @param unstakeCooldown_    seconds staked before requestUnstake may be called
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        address owner_,
        uint256 minStake_,
        uint256 minScoreToWithdraw_,
        address treasury_,
        uint256 minStakeDuration_,
        uint256 unstakeCooldown_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (minScoreToWithdraw_ > MAX_SCORE) revert ScoreOutOfRange(minScoreToWithdraw_);

        __ERC721_init(name_, symbol_);
        __Ownable_init(owner_);
        nextTokenId = 1;
        minStake = minStake_;
        minScoreToWithdraw = minScoreToWithdraw_;
        treasury = treasury_ == address(0) ? owner_ : treasury_;
        minStakeDuration = minStakeDuration_;
        unstakeCooldown = unstakeCooldown_;
        tierSilver = minStake_ * 2;
        tierGold = minStake_ * 5;
        emit MinStakeDurationUpdated(0, minStakeDuration_);
        emit UnstakeCooldownUpdated(0, unstakeCooldown_);
    }

    error ScoreOutOfRange(uint256 score);

    // ── Wiring ─────────────────────────────────────────────────────────────────
    // Deploy order: registry proxy -> escrow proxy(registry) -> registry.setEscrow(escrow).
    // setEscrow is one-shot: it can never be repointed, removing a whole class of
    // "owner repoints escrow to a malicious contract" attacks.

    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet(escrow);
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    // ── Registration & staking ─────────────────────────────────────────────────

    /**
     * @notice Self-registration: deposit at least `minStake` ETH to join the
     *         roster as an arbiter. Starts with the maximum trust score (100).
     * @return tokenId The minted, locked SBT id.
     */
    function registerArbiter() external payable returns (uint256 tokenId) {
        if (msg.value < minStake) revert StakeBelowMinimum(msg.value, minStake);
        tokenId = _enroll(msg.sender, msg.value);
    }

    /**
     * @notice Platform-vetted registration (owner = timelock). Also payable so
     *         the platform can seed an arbiter's stake in the same transaction.
     * @return tokenId The minted, locked SBT id.
     */
    function register(address arbiter) external payable onlyOwner returns (uint256 tokenId) {
        if (arbiter == address(0)) revert ZeroAddress();
        if (msg.value < minStake) revert StakeBelowMinimum(msg.value, minStake);
        tokenId = _enroll(arbiter, msg.value);
    }

    /**
     * @notice Top up an existing arbiter's collateral. Useful after a penalty
     *         drew the stake toward (or below) the floor.
     */
    function addStake() external payable {
        ArbiterInfo storage info = arbiters[msg.sender];
        if (!info.registered) revert NotRegistered(msg.sender);
        if (msg.value == 0) revert NoStake();
        info.stake += msg.value;
        emit StakeDeposited(msg.sender, msg.value, info.stake);
    }

    /**
     * @notice Signal intent to leave and reclaim collateral. Reverts if the
     *         stake is locked (score < minScoreToWithdraw) — a misbehaving
     *         arbiter cannot exit with their collateral — or if the stake
     *         hasn't aged `unstakeCooldown` yet (no join-and-leave sniping).
     * @dev    The escrow checks `unstakeRequested` and will not pick the arbiter
     *         for new disputes, so a request effectively benches them immediately.
     *         Withdrawal after a request is immediate (no second wait).
     */
    function requestUnstake() external {
        ArbiterInfo storage info = arbiters[msg.sender];
        if (!info.registered) revert NotRegistered(msg.sender);
        if (info.unstakeRequested) revert UnstakeAlreadyRequested();
        if (info.stake == 0) revert NoStake();
        if (_isBusy(msg.sender)) revert StillHandlingDispute(msg.sender);
        if (info.trustScore < minScoreToWithdraw) {
            emit StakeLocked(msg.sender, info.stake, info.trustScore);
            revert StakeIsLocked(info.trustScore, minScoreToWithdraw);
        }
        uint256 readyAt = info.stakedAt + unstakeCooldown;
        if (block.timestamp < readyAt) revert UnstakeTooEarly(readyAt);

        info.unstakeRequested = true;
        info.unstakeRequestedAt = block.timestamp; // record only; withdrawal follows immediately
        emit UnstakeRequested(msg.sender, info.stake);
    }

    /// @notice Cancel a pending unstake and rejoin the selection pool.
    function cancelUnstake() external {
        ArbiterInfo storage info = arbiters[msg.sender];
        if (!info.unstakeRequested) revert UnstakeNotRequested();
        info.unstakeRequested = false;
        info.unstakeRequestedAt = 0; // clear the request record
        emit UnstakeCancelled(msg.sender);
    }

    /**
     * @notice Withdraw collateral after `requestUnstake`. Immediate: the only
     *         wait in the exit flow is the pre-request stake aging enforced by
     *         `requestUnstake`. Requires the arbiter to be free of active
     *         disputes and to hold a healthy score.
     * @dev    Reentrancy-guarded; effects (zero the stake, clear flags) happen
     *         before the ETH transfer (CEI).
     */
    function withdrawStake() external nonReentrant {
        ArbiterInfo storage info = arbiters[msg.sender];
        if (!info.registered) revert NotRegistered(msg.sender);
        if (!info.unstakeRequested) revert UnstakeNotRequested();
        if (_isBusy(msg.sender)) revert StillHandlingDispute(msg.sender);
        if (info.trustScore < minScoreToWithdraw) {
            emit StakeLocked(msg.sender, info.stake, info.trustScore);
            revert StakeIsLocked(info.trustScore, minScoreToWithdraw);
        }
        uint256 amount = info.stake;
        if (amount == 0) revert NoStake();

        // EFFECTS before INTERACTION.
        info.stake = 0;
        info.unstakeRequested = false;
        info.unstakeRequestedAt = 0;
        info.registered = false; // leaves the roster; badge (SBT) stays as history
        _rosterRemove(msg.sender);

        emit StakeWithdrawn(msg.sender, amount);
        emit ArbiterDeregistered(msg.sender);
        _pay(msg.sender, amount);
    }

    // ── Escrow-only levers ─────────────────────────────────────────────────────

    /**
     * @notice Apply a trust-score delta after a dispute. The escrow decides the
     *         reason (majority / minority / missed / overturned) and this contract
     *         enforces the bounds and the slashing rule.
     *
     *         If the new score reaches 0 the arbiter is removed from the roster
     *         and their entire stake is slashed to the treasury.
     */
    function applyScoreChange(address arbiter, int256 delta, uint8 reason) external onlyEscrow {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.registered) revert NotRegistered(arbiter);

        uint256 oldScore = info.trustScore;
        uint256 newScore = _boundedScore(oldScore, delta);
        info.trustScore = newScore;
        info.resolutions += 1;

        emit ScoreChanged(arbiter, oldScore, newScore, reason);
        emit TrustScoreUpdated(arbiter, delta, newScore, delta >= 0);

        if (newScore == 0) _slash(arbiter);
        else if (newScore < minScoreToWithdraw) emit StakeLocked(arbiter, info.stake, newScore);
    }

    /**
     * @notice Escrow-driven slash: remove an arbiter (stale/missed) WITHOUT
     *         touching the stake, so the dispute can proceed with the remaining
     *         quorum. The stake stays locked for potential later slashing.
     */
    function slash(address arbiter) external onlyEscrow {
        _deregister(arbiter);
    }

    /**
     * @notice Full collateral slash to the treasury (score reached 0, or an
     *         overturned decision the escrow flags as a total loss). Removes the
     *         arbiter from the roster.
     */
    function slashStake(address arbiter) external onlyEscrow {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.registered) revert NotRegistered(arbiter);
        _slash(arbiter);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isRegistered(address arbiter) external view returns (bool) {
        return arbiters[arbiter].registered;
    }

    /**
     * @notice Whether an arbiter may be selected for a NEW dispute: registered,
     *         score at/above the withdrawal floor (i.e. not benched), not mid
     *         unstake, currently staked at least the minimum, and staked for at
     *         least `minStakeDuration` (the skin-in-the-game clock).
     */
    function isEligible(address arbiter) external view returns (bool) {
        ArbiterInfo storage info = arbiters[arbiter];
        return info.registered
            && !info.unstakeRequested
            && info.trustScore >= minScoreToWithdraw
            && info.stake >= minStake
            && block.timestamp >= info.stakedAt + minStakeDuration;
    }

    function trustScoreOf(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].trustScore;
    }

    function stakeOf(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].stake;
    }

    /// @notice Arbiter tier by collateral: 0 = none, 1 = bronze, 2 = silver, 3 = gold.
    /// @dev Pure stake read — selection weight already scales with stakeOf in Escrow.
    function tierOf(address arbiter) external view returns (uint8) {
        uint256 s = arbiters[arbiter].stake;
        if (!arbiters[arbiter].registered || s < minStake) return 0;
        if (tierGold > 0 && s >= tierGold) return 3;
        if (tierSilver > 0 && s >= tierSilver) return 2;
        return 1;
    }

    function isLocked(address arbiter) external view returns (bool) {
        ArbiterInfo storage info = arbiters[arbiter];
        return info.registered && info.trustScore < minScoreToWithdraw;
    }

    function resolutionsOf(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].resolutions;
    }

    function arbiterInfo(address arbiter) external view returns (ArbiterInfo memory) {
        return arbiters[arbiter];
    }

    /// @notice Unix time at which `arbiter` first becomes eligible (stakedAt + minStakeDuration).
    function eligibleAt(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].stakedAt + minStakeDuration;
    }

    /// @notice Unix time at which a pending unstake may be withdrawn: the
    ///         request timestamp itself (withdrawal is immediate; 0 if none).
    function unstakeReadyAt(address arbiter) external view returns (uint256) {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.unstakeRequested) return 0;
        return info.unstakeRequestedAt + unstakeCooldown;
    }

    /// @notice Number of arbiters currently on the roster (enumerable candidate set).
    function rosterLength() external view returns (uint256) {
        return roster.length;
    }

    /// @notice Arbiter at a roster index — lets the escrow draw candidates on-chain.
    function rosterAt(uint256 index) external view returns (address) {
        return roster[index];
    }

    /// @notice Snapshot the whole roster (bounded use only — prefer length+at for draws).
    function rosterSnapshot() external view returns (address[] memory) {
        return roster;
    }

    /// @notice ERC-5194 — badges are locked from the moment they are minted.
    function locked(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Set the minimum collateral for future joins / continuing members.
    function setMinStake(uint256 newMinStake) external onlyOwner {
        uint256 old = minStake;
        minStake = newMinStake;
        // Keep the tier invariant: silver/gold never sit below the floor.
        if (tierSilver < newMinStake) tierSilver = newMinStake;
        if (tierGold < newMinStake) tierGold = newMinStake;
        emit MinStakeUpdated(old, newMinStake);
    }

    /// @notice Set tier floors. Must satisfy minStake <= silver <= gold.
    function setTierThresholds(uint256 silverStake, uint256 goldStake) external onlyOwner {
        if (silverStake < minStake || goldStake < silverStake) revert BadTierThresholds(silverStake, goldStake, minStake);
        tierSilver = silverStake;
        tierGold = goldStake;
        emit TierThresholdsUpdated(silverStake, goldStake);
    }

    /// @notice Set the score threshold n below which stakes lock.
    function setMinScoreToWithdraw(uint256 newScore) external onlyOwner {
        if (newScore > MAX_SCORE) revert ScoreOutOfRange(newScore);
        uint256 old = minScoreToWithdraw;
        minScoreToWithdraw = newScore;
        emit MinScoreToWithdrawUpdated(old, newScore);
    }

    /// @notice Set the minimum continuous stake time (seconds) required before selection.
    function setMinStakeDuration(uint256 newSeconds) external onlyOwner {
        uint256 old = minStakeDuration;
        minStakeDuration = newSeconds;
        emit MinStakeDurationUpdated(old, newSeconds);
    }

    /// @notice Set the minimum staking time (seconds) before `requestUnstake`.
    function setUnstakeCooldown(uint256 newSeconds) external onlyOwner {
        uint256 old = unstakeCooldown;
        unstakeCooldown = newSeconds;
        emit UnstakeCooldownUpdated(old, newSeconds);
    }

    /// @notice Redirect slashed collateral.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    // ── Upgrade authorization ───────────────────────────────────────────────────

    /// @dev Only the owner (a TimelockController in production) may upgrade.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ── Internals ─────────────────────────────────────────────────────────────

    function _enroll(address arbiter, uint256 value) private returns (uint256 tokenId) {
        ArbiterInfo storage info = arbiters[arbiter];
        if (info.registered) revert AlreadyRegistered(arbiter);

        tokenId = nextTokenId++;
        info.registered = true;
        info.tokenId = tokenId;
        info.trustScore = MAX_SCORE; // new arbiters start perfect
        info.stake = value;
        info.unstakeRequested = false;
        info.stakedAt = block.timestamp; // starts the min-stake-duration clock
        info.unstakeRequestedAt = 0;

        _rosterAdd(arbiter);
        _mint(arbiter, tokenId);
        emit ArbiterRegistered(arbiter, tokenId);
        emit StakeDeposited(arbiter, value, value);
    }

    function _deregister(address arbiter) private {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.registered) revert NotRegistered(arbiter);
        info.registered = false;
        _rosterRemove(arbiter);
        emit ArbiterDeregistered(arbiter);
    }

    /// @dev Append/swap-remove roster bookkeeping (O(1) removal).
    function _rosterAdd(address arbiter) private {
        if (rosterIndex[arbiter] != 0) return;
        roster.push(arbiter);
        rosterIndex[arbiter] = roster.length; // 1-based
    }

    function _rosterRemove(address arbiter) private {
        uint256 idx = rosterIndex[arbiter];
        if (idx == 0) return;
        uint256 last = roster.length;
        if (idx != last) {
            address moved = roster[last - 1];
            roster[idx - 1] = moved;
            rosterIndex[moved] = idx;
        }
        roster.pop();
        rosterIndex[arbiter] = 0;
    }

    /// @dev Score is bounded to [0, MAX_SCORE]; positive deltas above the cap are clamped.
    function _boundedScore(uint256 oldScore, int256 delta) private pure returns (uint256) {
        if (delta >= 0) {
            uint256 sum = oldScore + uint256(delta);
            return sum > MAX_SCORE ? MAX_SCORE : sum;
        }
        uint256 dec = uint256(-delta);
        return oldScore > dec ? oldScore - dec : 0;
    }

    /**
     * @dev Whether `arbiter` is currently committed to one or more in-flight
     *      dispute rounds. The escrow is the source of truth for "active
     *      dispute" bookkeeping; the call is guarded so a registry-only deploy
     *      (escrow unset or misbehaving) cannot brick unstaking.
     */
    function _isBusy(address arbiter) private view returns (bool) {
        if (escrow == address(0)) return false;
        (bool ok, bytes memory data) =
            escrow.staticcall(abi.encodeWithSelector(bytes4(keccak256("activeDisputes(address)")), arbiter));
        if (!ok || data.length < 32) return false; // fail-open only when the escrow is absent/broken
        return abi.decode(data, (uint256)) > 0;
    }

    /// @dev Move the full collateral to the treasury and drop the arbiter.
    function _slash(address arbiter) private {        ArbiterInfo storage info = arbiters[arbiter];
        uint256 amount = info.stake;
        info.stake = 0;
        info.unstakeRequested = false;
        info.registered = false;
        _rosterRemove(arbiter);

        emit StakeSlashed(arbiter, treasury, amount);
        emit ArbiterDeregistered(arbiter);
        if (amount > 0) _pay(treasury, amount);
    }

    /// @dev Push payment — always the last effect (CEI).
    function _pay(address to, uint256 amount) private {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /// @dev Direct ETH transfers revert; collateral only enters via the staking API.
    receive() external payable {
        revert("ArbiterRegistry: direct transfers not allowed"); // solhint-disable-line reason-string
    }
}
