// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title OpenLanceTimelock
 * @notice A thin, unmodified subclass of OpenZeppelin's TimelockController.
 *
 * It exists only so the deployment scripts can reference a project-owned
 * artifact while keeping the audited OZ implementation byte-for-byte. It adds
 * no storage, no functions and no overrides — the bytecode is the OZ contract
 * plus a pass-through constructor.
 *
 * The timelock is the sole owner (upgrade authority) of the Escrow and
 * ArbiterRegistry UUPS proxies. Every upgrade and every owner-only call is
 * therefore publicly queued for `minDelay` before it can execute.
 */
contract OpenLanceTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
