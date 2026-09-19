// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {ArbiterRegistry} from "../src/ArbiterRegistry.sol";

/**
 * @title EventSurface
 * @notice Locks the contract event topic hashes to the backend's expected ABI,
 *         byte for byte.
 *
 *         The backend indexer (mini-services/api/src/chain/abi.ts) decodes logs
 *         with viem's parseAbi over these exact signatures — viem derives
 *         topic0 as keccak256 of the canonical signature (no `indexed`, no
 *         argument names), which is exactly what `Event.X.selector` is.
 *
 *         If a rename here ever breaks this test, the Solidity change is
 *         INCOMPATIBLE with the deployed backend — this is the guard that makes
 *         "the event surface is the contract" a checked fact instead of a hope.
 */
contract EventSurfaceTest is Test {
    // ── Expected canonical signatures (source: src/chain/abi.ts) ─────────────

    string constant MILESTONE_FUNDED = "MilestoneFunded(uint256,bytes32,address,address,uint256)";
    string constant MILESTONE_SUBMITTED = "MilestoneSubmitted(uint256,address)";
    string constant MILESTONE_RELEASED = "MilestoneReleased(uint256,address,uint256,uint256,bool)";
    string constant MILESTONE_REFUNDED = "MilestoneRefunded(uint256,address,uint256,bool)";
    string constant MILESTONE_SPLIT = "MilestoneSplit(uint256,uint256,uint256,uint256)";
    string constant MILESTONE_CANCELLED = "MilestoneCancelled(uint256,address,uint256)";
    string constant DISPUTE_OPENED = "DisputeOpened(uint256,address,uint256)";
    string constant DISPUTE_RESOLVED = "DisputeResolved(uint256,address,uint8)";
    string constant FEE_WITHDRAWN = "FeeWithdrawn(address,uint256)";
    string constant ARBITER_REGISTERED = "ArbiterRegistered(address,uint256)";
    string constant ARBITER_DEREGISTERED = "ArbiterDeregistered(address)";
    string constant TRUST_SCORE_UPDATED = "TrustScoreUpdated(address,int256,uint256,bool)";

    function _expect(string memory sig) internal pure returns (bytes32) {
        return keccak256(bytes(sig));
    }

    function test_EscrowEventTopicsMatchBackendAbi() public pure {
        assertEq(Escrow.MilestoneFunded.selector, _expect(MILESTONE_FUNDED), "MilestoneFunded");
        assertEq(Escrow.MilestoneSubmitted.selector, _expect(MILESTONE_SUBMITTED), "MilestoneSubmitted");
        assertEq(Escrow.MilestoneReleased.selector, _expect(MILESTONE_RELEASED), "MilestoneReleased");
        assertEq(Escrow.MilestoneRefunded.selector, _expect(MILESTONE_REFUNDED), "MilestoneRefunded");
        assertEq(Escrow.MilestoneSplit.selector, _expect(MILESTONE_SPLIT), "MilestoneSplit");
        assertEq(Escrow.MilestoneCancelled.selector, _expect(MILESTONE_CANCELLED), "MilestoneCancelled");
        assertEq(Escrow.DisputeOpened.selector, _expect(DISPUTE_OPENED), "DisputeOpened");
        assertEq(Escrow.DisputeResolved.selector, _expect(DISPUTE_RESOLVED), "DisputeResolved");
        assertEq(Escrow.FeeWithdrawn.selector, _expect(FEE_WITHDRAWN), "FeeWithdrawn");
    }

    function test_RegistryEventTopicsMatchBackendAbi() public pure {
        assertEq(ArbiterRegistry.ArbiterRegistered.selector, _expect(ARBITER_REGISTERED), "ArbiterRegistered");
        assertEq(ArbiterRegistry.ArbiterDeregistered.selector, _expect(ARBITER_DEREGISTERED), "ArbiterDeregistered");
        assertEq(ArbiterRegistry.TrustScoreUpdated.selector, _expect(TRUST_SCORE_UPDATED), "TrustScoreUpdated");
    }

    /// @dev The milestone status enum is API: the backend maps uint8 → status
    ///      name (ONCHAIN_MILESTONE_STATUS in src/chain/events.ts).
    function test_StatusEnumMatchesBackendMapping() public pure {
        assertEq(uint8(Escrow.Status.PendingFunding), 0, "0 = pending_funding");
        assertEq(uint8(Escrow.Status.Funded), 1, "1 = funded");
        assertEq(uint8(Escrow.Status.Submitted), 2, "2 = submitted");
        assertEq(uint8(Escrow.Status.Disputed), 3, "3 = disputed");
        assertEq(uint8(Escrow.Status.Released), 4, "4 = released");
        assertEq(uint8(Escrow.Status.ResolvedRelease), 5, "5 = resolved_release");
        assertEq(uint8(Escrow.Status.ResolvedRefund), 6, "6 = resolved_refund");
        assertEq(uint8(Escrow.Status.ResolvedSplit), 7, "7 = resolved_split");
        assertEq(uint8(Escrow.Status.Cancelled), 8, "8 = cancelled");
    }

    /// @dev Same for the resolution outcome enum (RESOLUTION_OUTCOMES in abi.ts).
    function test_OutcomeEnumMatchesBackendMapping() public pure {
        assertEq(uint8(Escrow.Outcome.Release), 0, "0 = release");
        assertEq(uint8(Escrow.Outcome.Refund), 1, "1 = refund");
        assertEq(uint8(Escrow.Outcome.Split), 2, "2 = split");
    }
}
