// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IArbiterRegistry
 * @notice The surface the Escrow contract depends on. The escrow compiles
 *         against this interface so its trust boundary is explicit:
 *
 *           - it can ask who is eligible to arbitrate,
 *           - it is the ONLY party allowed to apply trust-score changes and slashes.
 *
 * @dev The event payloads emitted by the implementation are part of the backend
 *      indexer contract; the topic hashes are locked by test/event-surface.ts.
 *      Do NOT reorder or rename them without updating the backend ABI mirror
 *      (src/server/chain/abi.ts).
 */
interface IArbiterRegistry {
    /// @notice Whether `arbiter` is on the roster at all.
    function isRegistered(address arbiter) external view returns (bool);

    /**
     * @notice Whether `arbiter` may be selected for a NEW dispute: registered,
     *         trust score at/above the withdrawal floor, not mid-unstake, and
     *         staked at least the minimum.
     */
    function isEligible(address arbiter) external view returns (bool);

    /// @notice Current trust score (0–100).
    function trustScoreOf(address arbiter) external view returns (uint256);

    /// @notice Current ETH collateral held for `arbiter`.
    function stakeOf(address arbiter) external view returns (uint256);

    /// @notice Arbiter tier by collateral: 0 = none, 1 = bronze, 2 = silver, 3 = gold.
    function tierOf(address arbiter) external view returns (uint8);

    /// @notice Score threshold n below which the stake is locked.
    function minScoreToWithdraw() external view returns (uint256);

    /// @notice Minimum continuous stake time (seconds) before an arbiter may be selected.
    function minStakeDuration() external view returns (uint256);

    /// @notice Delay (seconds) between requestUnstake and withdrawStake.
    function unstakeCooldown() external view returns (uint256);

    /// @notice Number of arbiters currently on the roster.
    function rosterLength() external view returns (uint256);

    /// @notice Arbiter at a roster index (for on-chain random selection).
    function rosterAt(uint256 index) external view returns (address);

    /**
     * @notice Apply a signed trust-score delta to an arbiter after a dispute.
     * @dev Callable only by the escrow. Emits ScoreChanged and (legacy)
     *      TrustScoreUpdated; reaches 0 → the escrow-defined `reason` plus a
     *      full collateral slash to the treasury.
     * @param arbiter the arbiter to score
     * @param delta   signed change (e.g. +5 majority, -10 minority, -15 missed, -25 overturned)
     * @param reason  one of the REASON_* constants on the implementation
     */
    function applyScoreChange(address arbiter, int256 delta, uint8 reason) external;

    /**
     * @notice Deregister an arbiter (stale/missed) WITHOUT touching the stake,
     *         so a dispute can still reach quorum with the remaining arbiters.
     * @dev Callable only by the escrow.
     */
    function slash(address arbiter) external;
}
