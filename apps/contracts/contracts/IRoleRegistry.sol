// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IRoleRegistry
 * @notice The surface a wallet (or the off-chain mirror) reads to learn which
 *         seat a wallet holds, and the surface the platform uses to move a
 *         wallet between seats for a fee.
 *
 *         Roles are wallet-owned state: they must outlive the off-chain
 *         database, so they live here and `users.role` is a mirror. See
 *         docs/intent/role-onchain.md.
 *
 * @dev The event payloads emitted by the implementation are part of the backend
 *      indexer contract. Do NOT reorder or rename them without updating the
 *      backend ABI mirror.
 */
interface IRoleRegistry {
    /// @notice The seat a wallet holds. `None` = never claimed (Role.None == 0).
    enum Role {
        None,
        Client,
        Freelancer,
        Arbiter
    }

    /// @notice The seat `account` holds, or `Role.None` if it never claimed.
    function roleOf(address account) external view returns (Role);

    /// @notice Whether `account` has consumed its one free write.
    function isClaimed(address account) external view returns (bool);

    /// @notice Timestamp of `account`'s claim; 0 if it never claimed.
    function claimedAt(address account) external view returns (uint256);

    /// @notice Wei required to move a wallet to a different seat.
    function roleChangeFee() external view returns (uint256);

    /// @notice Lifetime role-change fees collected by this contract, in wei.
    function totalFees() external view returns (uint256);

    /// @notice The ArbiterRegistry consulted for the "still staked" exit gate.
    function arbiterRegistry() external view returns (address);

    /// @notice Where collected fees are forwarded.
    function treasury() external view returns (address);
}
