// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ReentrancyAttacker
 * @notice A malicious freelancer/recipient used only by the test suite. It tries
 *         to reenter the escrow on every ETH receipt and records how many times
 *         its `receive` was entered, plus the observed escrow status.
 *
 * Used to prove: (a) the transient reentrancy guard blocks reentry on the payout
 * path, and (b) even if it did not, the state machine (Checks-Effects-
 * Interactions) has already flipped the milestone to a terminal state, so a
 * reentrant `approve`/`resolve` would hit WrongStatus/NotDisputed.
 */
interface IEscrowAttackerTarget {
    function submit(uint256 milestoneId) external;
    function approve(uint256 milestoneId) external;
    function cancel(uint256 milestoneId) external;
    function milestoneStatus(uint256 milestoneId) external view returns (uint8);
}

contract ReentrancyAttacker {
    IEscrowAttackerTarget public escrow;
    uint256 public reentryCount;
    uint8 public observedStatus;
    bool public lastReverted;

    constructor(address escrow_) {
        escrow = IEscrowAttackerTarget(escrow_);
    }

    /// @notice Act as the freelancer: submit the milestone so the client can approve.
    function submitWork(uint256 milestoneId) external {
        escrow.submit(milestoneId);
    }

    function attack(uint256 milestoneId) external {
        reentryCount++;
        try escrow.approve(milestoneId) {
            // If this ever succeeds, the guard + CEI both failed.
            lastReverted = false;
        } catch {
            lastReverted = true;
            observedStatus = escrow.milestoneStatus(milestoneId);
        }
    }

    receive() external payable {
        // Reenter the payout path. The guard must make this revert; the outer
        // `_pay` then bubbles TransferFailed and reverts the whole settlement.
        reentryCount++;
        escrow.approve(1);
    }
}
