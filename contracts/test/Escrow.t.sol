// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Escrow} from "../src/Escrow.sol";
import {ArbiterRegistry} from "../src/ArbiterRegistry.sol";

/**
 * @title EscrowTest — the milestone state machine, money math, and guards.
 *
 * Branch coverage target (PRD success criteria): every legal transition,
 * every illegal one, every access-control failure, the fee snapshot rule,
 * dispute coordination, SLA/slash windows, and CEI/reentrancy on payouts.
 */
contract EscrowTest is Test {
    Escrow escrow;
    ArbiterRegistry registry;

    address admin = makeAddr("admin");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");
    address arbiter = makeAddr("arbiter");
    address arbiter2 = makeAddr("arbiter2");
    address rando = makeAddr("rando");

    uint256 constant AMOUNT = 1 ether; // fee 0.025 @ 250bps
    uint256 constant FEE = 0.025 ether;
    uint256 constant PRINCIPAL = 0.975 ether;
    bytes32 constant REF = bytes32(uint256(0xdeadbeef));

    function setUp() public {
        registry = new ArbiterRegistry("OpenLance Arbiter", "OLANCE", admin);
        escrow = new Escrow(registry, admin);
        vm.prank(admin);
        registry.setEscrow(address(escrow));
        vm.startPrank(admin);
        registry.register(arbiter);
        registry.register(arbiter2);
        vm.stopPrank();
        vm.deal(client, 100 ether);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _fund() internal returns (uint256 id) {
        return _fund(client, freelancer, AMOUNT, REF);
    }

    function _fund(address c, address f, uint256 amount, bytes32 ref) internal returns (uint256 id) {
        vm.prank(c);
        escrow.fund{value: amount}(ref, f);
        return escrow.nextMilestoneId() - 1;
    }

    function _submit(uint256 id) internal {
        Escrow.Milestone memory m = escrow.getMilestone(id);
        vm.prank(m.freelancer);
        escrow.submit(id);
    }

    function _dispute(uint256 id, address by) internal {
        vm.prank(by);
        escrow.openDispute(id);
    }

    function _assignByMutualNomination(uint256 id, address who) internal {
        Escrow.Milestone memory m = escrow.getMilestone(id);
        vm.prank(m.client);
        escrow.nominateArbiter(id, who);
        vm.prank(m.freelancer);
        escrow.nominateArbiter(id, who);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Funding (F4)
    // ─────────────────────────────────────────────────────────────────────────

    function test_fund_HappyPath() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Escrow.MilestoneFunded(1, REF, client, freelancer, AMOUNT);
        uint256 id = _fund();

        Escrow.Milestone memory m = escrow.getMilestone(id);
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Funded));
        assertEq(m.ref, REF);
        assertEq(m.client, client);
        assertEq(m.freelancer, freelancer);
        assertEq(m.amount, AMOUNT);
        assertEq(uint256(m.feeBps), 250, "fee snapshot taken at funding");
        assertEq(address(escrow).balance, AMOUNT);
        assertEq(client.balance, 100 ether - AMOUNT);
    }

    function test_fund_SequentialIdsFromOne() public {
        assertEq(_fund(), 1, "ids start at 1 (matches the mock chain)");
        assertEq(_fund(), 2);
        assertEq(_fund(), 3);
    }

    function test_fund_RevertZeroValue() public {
        vm.prank(client);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.fund(REF, freelancer);
    }

    function test_fund_RevertFreelancerZero() public {
        vm.prank(client);
        vm.expectRevert(Escrow.InvalidFreelancer.selector);
        escrow.fund{value: AMOUNT}(REF, address(0));
    }

    function test_fund_RevertFreelancerIsClient() public {
        vm.prank(client);
        vm.expectRevert(Escrow.InvalidFreelancer.selector);
        escrow.fund{value: AMOUNT}(REF, client);
    }

    function test_fund_RevertDirectEthTransfer() public {
        // All value must enter through fund() — keeps solvency accounting exact.
        vm.expectRevert(bytes("Escrow: direct transfers not allowed"));
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertTrue(ok, "unreachable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy path: submit → approve (F5)
    // ─────────────────────────────────────────────────────────────────────────

    function test_submit_HappyPath() public {
        uint256 id = _fund();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.MilestoneSubmitted(id, freelancer);
        _submit(id);
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Submitted));
    }

    function test_submit_OnlyFreelancer() public {
        uint256 id = _fund();
        vm.prank(client);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        escrow.submit(id);
    }

    function test_submit_RevertWhenNotFunded() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(freelancer);
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.WrongStatus.selector, Escrow.Status.Funded, Escrow.Status.Submitted)
        );
        escrow.submit(id);
    }

    function test_approve_HappyPath_FeeMathAndPayout() public {
        uint256 id = _fund();
        _submit(id);

        uint256 freelancerBefore = freelancer.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.MilestoneReleased(id, freelancer, PRINCIPAL, FEE, false);
        vm.prank(client);
        escrow.approve(id);

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Released));
        assertEq(freelancer.balance - freelancerBefore, PRINCIPAL);
        assertEq(escrow.accruedFees(), FEE);
        assertEq(address(escrow).balance, AMOUNT - PRINCIPAL, "fee stays escrowed until withdrawal");
    }

    function test_approve_OnlyClient() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotClient.selector);
        escrow.approve(id);
    }

    function test_approve_RevertWhenNotSubmitted() public {
        uint256 id = _fund(); // still Funded
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.WrongStatus.selector, Escrow.Status.Submitted, Escrow.Status.Funded)
        );
        escrow.approve(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cancel (F4)
    // ─────────────────────────────────────────────────────────────────────────

    function test_cancel_HappyPath_FullRefund() public {
        uint256 id = _fund();
        uint256 clientBefore = client.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.MilestoneCancelled(id, client, AMOUNT);
        vm.prank(client);
        escrow.cancel(id);

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Cancelled));
        assertEq(client.balance, clientBefore + AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_cancel_OnlyClient() public {
        uint256 id = _fund();
        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotClient.selector);
        escrow.cancel(id);
    }

    function test_cancel_RevertAfterSubmission() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.WrongStatus.selector, Escrow.Status.Funded, Escrow.Status.Submitted)
        );
        escrow.cancel(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Disputes (F10) — open, nominate, assign
    // ─────────────────────────────────────────────────────────────────────────

    function test_dispute_FromFunded() public {
        uint256 id = _fund();
        vm.warp(1_000_000);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.DisputeOpened(id, client, AMOUNT);
        _dispute(id, client);

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Disputed));
        Escrow.Dispute memory d = escrow.getDispute(id);
        assertEq(d.openedBy, client);
        assertEq(d.openedAt, 1_000_000);
        assertEq(d.agreementDeadline, 1_000_000 + 48 hours);
        assertEq(d.arbiter, address(0), "not assigned yet");
    }

    function test_dispute_FromSubmitted() public {
        uint256 id = _fund();
        _submit(id);
        _dispute(id, freelancer);
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Disputed));
    }

    function test_dispute_EitherParty() public {
        uint256 id = _fund();
        _dispute(id, freelancer);
        assertEq(escrow.getDispute(id).openedBy, freelancer);
    }

    function test_dispute_OnlyParty() public {
        uint256 id = _fund();
        vm.prank(rando);
        vm.expectRevert(Escrow.NotParty.selector);
        escrow.openDispute(id);
    }

    function test_dispute_RevertWhenTerminal() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(client);
        escrow.approve(id);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.NotDisputable.selector, Escrow.Status.Released)
        );
        escrow.openDispute(id);
    }

    function test_nominate_SingleNominationDoesNotAssign() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.prank(client);
        escrow.nominateArbiter(id, arbiter);
        assertEq(escrow.getDispute(id).arbiter, address(0));
    }

    function test_nominate_MutualAgreementAssignsAndStartsSla() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.warp(2_000_000);

        _assignByMutualNomination(id, arbiter);

        Escrow.Dispute memory d = escrow.getDispute(id);
        assertEq(d.arbiter, arbiter);
        assertEq(d.slaDeadline, 2_000_000 + 72 hours);
    }

    function test_nominate_DifferentCandidatesDoNotAssign() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.prank(client);
        escrow.nominateArbiter(id, arbiter);
        vm.prank(freelancer);
        escrow.nominateArbiter(id, arbiter2);
        assertEq(escrow.getDispute(id).arbiter, address(0));
    }

    function test_nominate_RequiresRegistered() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ArbiterNotRegistered.selector, rando));
        escrow.nominateArbiter(id, rando);
    }

    function test_nominate_OnlyParty() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.prank(rando);
        vm.expectRevert(Escrow.NotParty.selector);
        escrow.nominateArbiter(id, arbiter);
    }

    function test_nominate_RevertAfterAssignment() public {
        uint256 id = _fund();
        _dispute(id, client);
        _assignByMutualNomination(id, arbiter);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ArbiterAlreadyAssigned.selector, arbiter));
        escrow.nominateArbiter(id, arbiter2);
    }

    function test_adminAssign_RevertInsideAgreementWindow() public {
        vm.warp(1_000_000);
        uint256 id = _fund();
        _dispute(id, client); // agreementDeadline = 1_000_000 + 48h
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AgreementWindowOpen.selector, 1_000_000 + 48 hours));
        escrow.adminAssignArbiter(id, arbiter);
    }

    function test_adminAssign_AfterWindowAssigns() public {
        uint256 id = _fund();
        vm.warp(1_000_000);
        _dispute(id, client);
        vm.warp(1_000_000 + 48 hours + 1);
        vm.prank(admin);
        escrow.adminAssignArbiter(id, arbiter2);

        Escrow.Dispute memory d = escrow.getDispute(id);
        assertEq(d.arbiter, arbiter2);
        assertEq(d.slaDeadline, block.timestamp + 72 hours);
    }

    function test_adminAssign_OnlyOwner() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.warp(block.timestamp + 49 hours);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        escrow.adminAssignArbiter(id, arbiter);
    }

    function test_adminAssign_RevertWhenAlreadyAssigned() public {
        uint256 id = _fund();
        _dispute(id, client);
        _assignByMutualNomination(id, arbiter);
        vm.warp(block.timestamp + 49 hours);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ArbiterAlreadyAssigned.selector, arbiter));
        escrow.adminAssignArbiter(id, arbiter2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolution (F10/F12) — release / refund / split, SLA, trust score
    // ─────────────────────────────────────────────────────────────────────────

    function _disputedAndAssigned(uint256 amount) internal returns (uint256 id) {
        id = _fund(client, freelancer, amount, REF);
        _dispute(id, client);
        _assignByMutualNomination(id, arbiter);
    }

    function test_resolve_Release() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        uint256 freelancerBefore = freelancer.balance;

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.ResolvedRelease));
        assertEq(freelancer.balance - freelancerBefore, PRINCIPAL);
        assertEq(escrow.accruedFees(), FEE, "fee on the full amount");
        assertEq(registry.trustScoreOf(arbiter), 1, "+1 within SLA");
    }

    function test_resolve_Refund() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        uint256 clientBefore = client.balance;

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Refund));

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.ResolvedRefund));
        assertEq(client.balance - clientBefore, AMOUNT, "full refund");
        assertEq(escrow.accruedFees(), 0, "no fee on refunds");
        assertEq(registry.trustScoreOf(arbiter), 1);
    }

    function test_resolve_Split() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        uint256 clientBefore = client.balance;
        uint256 freelancerBefore = freelancer.balance;

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Split));

        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.ResolvedSplit));
        // 50/50: fee applies ONLY to the released (freelancer) half
        assertEq(freelancer.balance - freelancerBefore, 0.4875 ether);
        assertEq(client.balance - clientBefore, 0.5 ether);
        assertEq(escrow.accruedFees(), 0.0125 ether);
        // exact conservation: client + freelancer + fee == amount
        assertEq((client.balance - clientBefore) + (freelancer.balance - freelancerBefore) + escrow.accruedFees(), AMOUNT);
    }

    function test_resolve_SplitOddAmountConservesWei() public {
        uint256 id = _disputedAndAssigned(3 wei);
        uint256 clientBefore = client.balance;
        uint256 freelancerBefore = freelancer.balance;

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Split));

        // half = 1 wei, fee = 0, freelancer = 1, client = 2 (odd wei to client)
        assertEq(freelancer.balance - freelancerBefore, 1);
        assertEq(client.balance - clientBefore, 2);
        assertEq(escrow.accruedFees(), 0);
    }

    function test_resolve_OnlyAssignedArbiter() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.prank(arbiter2);
        vm.expectRevert(Escrow.NotAssignedArbiter.selector);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));
    }

    function test_resolve_RevertWithoutArbiter() public {
        uint256 id = _fund();
        _dispute(id, client); // nominated nobody
        vm.prank(arbiter);
        vm.expectRevert(Escrow.NoArbiterAssigned.selector);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));
    }

    function test_resolve_RevertNotDisputed() public {
        uint256 id = _fund();
        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotDisputed.selector);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));
    }

    function test_resolve_InvalidOutcome() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidOutcome.selector, 3));
        escrow.resolveDispute(id, 3);
    }

    function test_resolve_LateResolutionScoresMinusTwo() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.warp(escrow.getDispute(id).slaDeadline + 1); // late by one second

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Refund));

        assertEq(registry.trustScoreOf(arbiter), 0, "0 - 2 floors at zero");
        assertEq(registry.resolutionsOf(arbiter), 1);
    }

    function test_resolve_TrustScoreFloorNeverUnderflows() public {
        // arbiter earns 1, then goes late twice: 1 → 0 → 0
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Refund));
        assertEq(registry.trustScoreOf(arbiter), 1);

        uint256 id2 = _disputedAndAssigned(AMOUNT);
        vm.warp(escrow.getDispute(id2).slaDeadline + 1);
        vm.prank(arbiter);
        escrow.resolveDispute(id2, uint8(Escrow.Outcome.Refund));
        assertEq(registry.trustScoreOf(arbiter), 0);

        uint256 id3 = _disputedAndAssigned(AMOUNT);
        vm.warp(escrow.getDispute(id3).slaDeadline + 1);
        vm.prank(arbiter);
        escrow.resolveDispute(id3, uint8(Escrow.Outcome.Refund));
        assertEq(registry.trustScoreOf(arbiter), 0, "still zero, never negative");
    }

    function test_resolve_TrustScoreAccumulatesOnTime() public {
        for (uint256 i = 0; i < 3; i++) {
            uint256 id = _disputedAndAssigned(AMOUNT);
            vm.prank(arbiter);
            escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));
        }
        assertEq(registry.trustScoreOf(arbiter), 3);
        assertEq(registry.resolutionsOf(arbiter), 3);
    }

    /// @dev The event ORDER inside resolveDispute is load-bearing: the backend
    ///      mock emits DisputeResolved → settlement → TrustScoreUpdated, and the
    ///      indexer applies state in (block, logIndex) order.
    function test_resolve_EventOrderMatchesBackendPipeline() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.recordLogs();

        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[] memory seen = new bytes32[](3);
        uint256 found;
        for (uint256 i = 0; i < logs.length && found < 3; i++) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == Escrow.DisputeResolved.selector) {
                seen[found++] = Escrow.DisputeResolved.selector;
            } else if (logs[i].emitter == address(escrow) && logs[i].topics[0] == Escrow.MilestoneReleased.selector) {
                seen[found++] = Escrow.MilestoneReleased.selector;
            } else if (logs[i].emitter == address(registry) && logs[i].topics[0] == ArbiterRegistry.TrustScoreUpdated.selector) {
                seen[found++] = ArbiterRegistry.TrustScoreUpdated.selector;
            }
        }
        assertEq(found, 3, "all three key events present");
        assertEq(seen[0], Escrow.DisputeResolved.selector, "1st: DisputeResolved");
        assertEq(seen[1], Escrow.MilestoneReleased.selector, "2nd: settlement event");
        assertEq(seen[2], ArbiterRegistry.TrustScoreUpdated.selector, "3rd: TrustScoreUpdated (registry)");
    }

    /// @dev An arbiter deregistered AFTER assignment can still resolve (no
    ///      deadlock); no TrustScoreUpdated is emitted, so the backend mirror
    ///      stays consistent (no event → no score bump).
    function test_resolve_DeregisteredArbiterStillResolves() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        vm.prank(admin);
        registry.deregister(arbiter);

        vm.recordLogs();
        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Refund)); // must NOT revert

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(registry)) {
                assertFalse(
                    logs[i].topics[0] == ArbiterRegistry.TrustScoreUpdated.selector,
                    "no trust-score event for a deregistered arbiter"
                );
            }
        }
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.ResolvedRefund));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Slash (F12)
    // ─────────────────────────────────────────────────────────────────────────

    function test_slash_RevertBeforeSlaPlusGrace() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        Escrow.Dispute memory d = escrow.getDispute(id);

        vm.warp(d.slaDeadline); // exactly at SLA: still inside grace
        vm.expectRevert(abi.encodeWithSelector(Escrow.SlashWindowNotOpen.selector, d.slaDeadline + 24 hours));
        escrow.slashStaleArbiter(id);
    }

    function test_slash_RemovesArbiterAndReopensAssignment() public {
        uint256 id = _disputedAndAssigned(AMOUNT);
        Escrow.Dispute memory d = escrow.getDispute(id);
        vm.warp(d.slaDeadline + 24 hours + 1);

        vm.expectEmit(true, false, false, false, address(registry));
        emit ArbiterRegistry.ArbiterDeregistered(arbiter);
        escrow.slashStaleArbiter(id); // anyone may call

        assertFalse(registry.isRegistered(arbiter));
        Escrow.Dispute memory disputeAfter = escrow.getDispute(id);
        assertEq(disputeAfter.arbiter, address(0), "assignment cleared");
        assertEq(disputeAfter.slaDeadline, 0);
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Disputed), "dispute stays open");

        // the stale arbiter can no longer resolve
        vm.prank(arbiter);
        vm.expectRevert(Escrow.NoArbiterAssigned.selector);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Release));

        // admin (or parties) can assign a fresh arbiter — 48h window long passed
        vm.prank(admin);
        escrow.adminAssignArbiter(id, arbiter2);
        assertEq(escrow.getDispute(id).arbiter, arbiter2);
    }

    function test_slash_RevertWithoutAssignedArbiter() public {
        uint256 id = _fund();
        _dispute(id, client);
        vm.warp(block.timestamp + 200 hours);
        vm.expectRevert(Escrow.NoArbiterAssigned.selector);
        escrow.slashStaleArbiter(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees & admin
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdrawFees_HappyPath() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(client);
        escrow.approve(id);

        uint256 adminBefore = admin.balance;
        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.FeeWithdrawn(admin, FEE);
        vm.prank(admin);
        escrow.withdrawFees(admin);

        assertEq(admin.balance - adminBefore, FEE);
        assertEq(escrow.accruedFees(), 0);
        assertEq(address(escrow).balance, 0);
    }

    function test_withdrawFees_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        escrow.withdrawFees(rando);
    }

    function test_withdrawFees_RevertWhenNothingAccrued() public {
        vm.prank(admin);
        vm.expectRevert(Escrow.NothingToWithdraw.selector);
        escrow.withdrawFees(admin);
    }

    function test_setFeeBps_SnapshotsAtFunding() public {
        uint256 id1 = _fund(); // snapshot 250 bps

        vm.prank(admin);
        escrow.setFeeBps(500);
        assertEq(uint256(escrow.feeBps()), 500);

        uint256 id2 = _fund(); // snapshot 500 bps

        // settle both — each uses its own snapshot (PRD: in-flight unaffected)
        _submit(id1);
        vm.prank(client);
        escrow.approve(id1);
        _submit(id2);
        vm.prank(client);
        escrow.approve(id2);

        assertEq(escrow.accruedFees(), FEE + 0.05 ether, "0.025 (old snapshot) + 0.05 (new)");
    }

    function test_setFeeBps_RevertAboveCap() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Escrow.FeeTooHigh.selector, 501, 500));
        escrow.setFeeBps(501);
    }

    function test_setFeeBps_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        escrow.setFeeBps(100);
    }

    /// @dev Admin handover keeps the fee lever alive: ownership transfer moves
    ///      withdrawFees/setFeeBps rights to the new operator.
    function test_admin_ownershipHandoverKeepsFeeLever() public {
        uint256 id = _fund();
        _submit(id);
        vm.prank(client);
        escrow.approve(id);
        assertEq(escrow.accruedFees(), FEE);

        vm.prank(admin);
        escrow.transferOwnership(rando);
        assertEq(escrow.owner(), rando);

        vm.prank(rando);
        escrow.withdrawFees(rando); // new admin operates the fee pot
        assertEq(rando.balance, FEE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function test_milestoneStatus_UnknownIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Escrow.UnknownMilestone.selector, 0));
        escrow.milestoneStatus(0);
        vm.expectRevert(abi.encodeWithSelector(Escrow.UnknownMilestone.selector, 1));
        escrow.milestoneStatus(1);
    }

    function test_getMilestone_UnknownIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Escrow.UnknownMilestone.selector, 99));
        escrow.getMilestone(99);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reentrancy (PRD §7.4: nonReentrant + CEI on all payout paths)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev BOTH defenses, proven in one attack:
     *      1. nonReentrant is the first line (modifier runs before body checks)
     *         → the inner call dies with ReentrancyGuardReentrantCall.
     *      2. CEI is the second line — the attacker OBSERVES the milestone
     *         status mid-payout and it is ALREADY Released, so even a
     *         guard-bypassing reentry would fail the WrongStatus check.
     *      The outer payout completes; the attacker is paid exactly once.
     */
    function test_reentrancy_ApproveSameMilestone_BothDefensesProven() public {
        ReentrantPayee evil = new ReentrantPayee(escrow);
        uint256 id = _fund(client, address(evil), AMOUNT, REF);
        evil.submit(id);
        evil.setAttack(id, 0, 0); // reenter approve(same milestone)

        vm.prank(client);
        escrow.approve(id); // succeeds — the attack was swallowed, not propagated

        assertTrue(evil.reentered(), "the attack did fire");
        assertEq(
            evil.innerRevert(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "guard fired first (modifier precedence)"
        );
        assertEq(
            evil.statusObserved(),
            uint8(Escrow.Status.Released),
            "CEI: status was already final BEFORE the payout began - a guard bypass would still hit WrongStatus"
        );
        assertEq(uint8(escrow.milestoneStatus(id)), uint8(Escrow.Status.Released));
        assertEq(address(evil).balance, PRINCIPAL, "freelancer paid exactly once");
    }

    /**
     * @dev Defense #2 — the reentrancy guard. Here the inner call targets a
     *      DIFFERENT milestone where the attacker legitimately passes every
     *      state check (it is the assigned arbiter of B, B is Disputed), so
     *      only nonReentrant stops the cross-contract reentry.
     */
    function test_reentrancy_ResolveCrossMilestone_GuardBlocks() public {
        ReentrantPayee evil = new ReentrantPayee(escrow);
        vm.prank(admin);
        registry.register(address(evil));

        // Milestone A: evil is the FREELANCER (about to be paid).
        uint256 a = _fund(client, address(evil), AMOUNT, REF);
        _dispute(a, client);
        vm.prank(client);
        escrow.nominateArbiter(a, arbiter);
        evil.nominate(a, arbiter); // both parties agreed → assigned

        // Milestone B: evil is the assigned ARBITER (inner call would pass checks).
        uint256 b = _fund();
        _dispute(b, client);
        _assignByMutualNomination(b, address(evil));

        evil.setAttack(b, 1, uint8(Escrow.Outcome.Release)); // reenter resolveDispute(B)

        vm.prank(arbiter);
        escrow.resolveDispute(a, uint8(Escrow.Outcome.Release)); // pays evil → triggers reentry

        assertTrue(evil.reentered(), "the attack did fire");
        assertEq(
            evil.innerRevert(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the guard fired: state checks alone would NOT have stopped this one"
        );
        assertEq(
            evil.statusObserved(),
            uint8(Escrow.Status.Disputed),
            "B was still a legal resolve target - ONLY the guard stopped this"
        );
        // nothing double-settled: B untouched, evil paid once (for A)
        assertEq(uint8(escrow.milestoneStatus(b)), uint8(Escrow.Status.Disputed), "B still disputed");
        assertEq(uint8(escrow.milestoneStatus(a)), uint8(Escrow.Status.ResolvedRelease));
        assertEq(address(evil).balance, PRINCIPAL);
        assertEq(registry.trustScoreOf(address(evil)), 0, "no trust score for a resolution that never happened");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: the money math must conserve for ANY amount and ANY legal fee
    // ─────────────────────────────────────────────────────────────────────────

    function test_fuzz_ReleaseConservation(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 500));
        amount = bound(amount, 1, 1e30);
        if (bps != 250) {
            vm.prank(admin);
            escrow.setFeeBps(bps);
        }
        vm.deal(client, amount + 1 ether);

        uint256 id = _fund(client, freelancer, amount, REF);
        _submit(id);
        vm.prank(client);
        escrow.approve(id);

        uint256 fee = (amount * bps) / 10_000;
        assertEq(escrow.accruedFees(), fee, "floor fee matches backend feeOf");
        assertEq(freelancer.balance, amount - fee, "principal to freelancer");
        assertEq(address(escrow).balance, fee, "only the fee remains escrowed");
        assertEq(fee + (amount - fee), amount, "exact conservation");
    }

    function test_fuzz_SplitConservation(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 500));
        amount = bound(amount, 1, 1e30);
        if (bps != 250) {
            vm.prank(admin);
            escrow.setFeeBps(bps);
        }
        vm.deal(client, amount + 1 ether);
        uint256 clientBefore = client.balance;

        uint256 id = _fund(client, freelancer, amount, REF);
        _dispute(id, client);
        _assignByMutualNomination(id, arbiter);
        vm.prank(arbiter);
        escrow.resolveDispute(id, uint8(Escrow.Outcome.Split));

        uint256 half = amount / 2;
        uint256 fee = (half * bps) / 10_000;
        assertEq(escrow.accruedFees(), fee, "fee on the released half only");
        assertEq(freelancer.balance, half - fee);
        assertEq(client.balance, clientBefore - half, "client net: paid amount, received amount - half");
        // client share + freelancer share + fee == amount, to the wei
        assertEq((amount - half) + (half - fee) + fee, amount, "exact conservation");
    }
}

/**
 * @dev A payout receiver that reenters the escrow mid-payout and CAPTURES the
 *      revert reason of the inner call, so tests can assert which defense
 *      stopped it. mode 0 = reenter approve, mode 1 = reenter resolveDispute.
 */
contract ReentrantPayee {
    Escrow public immutable escrow;
    uint256 public target;
    uint8 public mode;
    uint8 public outcome;
    bool public reentered;
    bytes public innerRevert;
    uint8 public statusObserved; // what the contract looked like mid-payout

    constructor(Escrow escrow_) {
        escrow = escrow_;
    }

    function setAttack(uint256 target_, uint8 mode_, uint8 outcome_) external {
        target = target_;
        mode = mode_;
        outcome = outcome_;
    }

    function submit(uint256 id) external {
        escrow.submit(id);
    }

    function nominate(uint256 id, address candidate) external {
        escrow.nominateArbiter(id, candidate);
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        statusObserved = uint8(escrow.milestoneStatus(target)); // CEI evidence
        if (mode == 0) {
            try escrow.approve(target) {
                // inner call SUCCEEDED mid-payout — catastrophic
            } catch (bytes memory reason) {
                innerRevert = reason;
            }
        } else {
            try escrow.resolveDispute(target, outcome) {
                // inner call SUCCEEDED mid-payout — catastrophic
            } catch (bytes memory reason) {
                innerRevert = reason;
            }
        }
    }
}
