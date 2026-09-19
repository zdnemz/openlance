// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IArbiterRegistry
 * @notice The minimal surface the Escrow contract depends on. The escrow
 *         compiles against this interface so its trust boundary is explicit:
 *         it can ask who is registered, and it is the ONLY party allowed to
 *         record resolutions and slash stale arbiters.
 *
 *         Event payloads emitted by the implementation (ArbiterRegistered,
 *         ArbiterDeregistered, TrustScoreUpdated) are part of the backend's
 *         indexer contract — see mini-services/api/src/chain/abi.ts.
 */
interface IArbiterRegistry {
    /**
     * @notice Whether `arbiter` is currently registered (an active, vetted arbiter).
     * @dev The Postgres `arbiters` mirror is an untrusted cache of this fact.
     */
    function isRegistered(address arbiter) external view returns (bool);

    /**
     * @notice Record one dispute resolution against an arbiter's SLA record.
     * @dev Callable only by the escrow. Emits TrustScoreUpdated:
     *      +1 within SLA, −2 late, floored at zero (PRD F12).
     */
    function recordResolution(address arbiter, bool withinSla) external;

    /**
     * @notice Remove an arbiter who blew the resolution SLA + grace period.
     * @dev Callable only by the escrow. Emits ArbiterDeregistered.
     */
    function slash(address arbiter) external;
}
