// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArbiterRegistry} from "../src/ArbiterRegistry.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @title ArbiterRegistryTest — registration, ERC-5194 soulbinding, trust math.
 * @notice Trust score rules under test (PRD F12):
 *         +1 within SLA · −2 late · floored at zero · slash removes from roster.
 */
contract ArbiterRegistryTest is Test {
    ArbiterRegistry registry;
    Escrow escrow;

    address admin = makeAddr("admin");
    address arbiter = makeAddr("arbiter");
    address otherArbiter = makeAddr("otherArbiter");
    address rando = makeAddr("rando");

    function setUp() public {
        registry = new ArbiterRegistry("OpenLance Arbiter", "OLANCE", admin);
        escrow = new Escrow(registry, admin);
        vm.prank(admin);
        registry.setEscrow(address(escrow));
    }

    function _register(address who) internal returns (uint256 tokenId) {
        vm.prank(admin);
        tokenId = registry.register(who);
    }

    // ── Registration ──────────────────────────────────────────────────────────

    function test_register_MintsLockedSbt() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit ArbiterRegistry.ArbiterRegistered(arbiter, 1);
        uint256 tokenId = _register(arbiter);

        assertEq(tokenId, 1, "first token id is 1 (matches mock chain)");
        assertTrue(registry.isRegistered(arbiter));
        assertEq(registry.ownerOf(tokenId), arbiter);
        assertTrue(registry.locked(tokenId), "ERC-5194: locked from birth");
        assertEq(registry.trustScoreOf(arbiter), 0);
        assertEq(registry.resolutionsOf(arbiter), 0);
        assertEq(registry.nextTokenId(), 2);
    }

    /// @dev The ERC-5192 `Locked` signal fires on mint (inside _update).
    function test_register_EmitsErc5192Locked() public {
        vm.expectEmit(true, false, false, false, address(registry));
        emit ArbiterRegistry.Locked(1);
        _register(arbiter);
    }

    function test_register_SequentialTokenIds() public {
        assertEq(_register(arbiter), 1);
        assertEq(_register(otherArbiter), 2);
        assertEq(_register(makeAddr("third")), 3);
    }

    function test_register_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        registry.register(arbiter);
    }

    function test_register_AlreadyRegistered() public {
        _register(arbiter);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.AlreadyRegistered.selector, arbiter));
        registry.register(arbiter);
    }

    function test_register_ZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ArbiterRegistry.ZeroAddress.selector);
        registry.register(address(0));
    }

    // ── ERC-5194: soulbinding ─────────────────────────────────────────────────

    function test_sbt_TransferReverts() public {
        uint256 tokenId = _register(arbiter);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.NonTransferable.selector, tokenId));
        registry.transferFrom(arbiter, rando, tokenId);
    }

    function test_sbt_SafeTransferReverts() public {
        uint256 tokenId = _register(arbiter);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.NonTransferable.selector, tokenId));
        registry.safeTransferFrom(arbiter, rando, tokenId);
    }

    function test_sbt_ApprovedTransferStillReverts() public {
        uint256 tokenId = _register(arbiter);
        vm.prank(arbiter);
        registry.approve(rando, tokenId);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.NonTransferable.selector, tokenId));
        registry.transferFrom(arbiter, rando, tokenId);
        // badge never left
        assertEq(registry.ownerOf(tokenId), arbiter);
        assertTrue(registry.locked(tokenId));
    }

    /// @dev Deregistration keeps the badge: the SBT is history, not membership.
    function test_sbt_BadgeSurvivesDeregistration() public {
        uint256 tokenId = _register(arbiter);
        vm.prank(arbiter);
        registry.deregister(arbiter);

        assertFalse(registry.isRegistered(arbiter));
        assertEq(registry.ownerOf(tokenId), arbiter, "badge not burned");
        assertTrue(registry.locked(tokenId));
    }

    // ── Deregistration ────────────────────────────────────────────────────────

    function test_deregister_Self() public {
        _register(arbiter);
        vm.expectEmit(true, false, false, false, address(registry));
        emit ArbiterRegistry.ArbiterDeregistered(arbiter);
        vm.prank(arbiter);
        registry.deregister(arbiter);
        assertFalse(registry.isRegistered(arbiter));
    }

    function test_deregister_Owner() public {
        _register(arbiter);
        vm.prank(admin);
        registry.deregister(arbiter);
        assertFalse(registry.isRegistered(arbiter));
    }

    function test_deregister_Escrow() public {
        _register(arbiter);
        // the escrow contract itself is authorized (slash path)
        vm.prank(address(escrow));
        registry.deregister(arbiter);
        assertFalse(registry.isRegistered(arbiter));
    }

    function test_deregister_Unauthorized() public {
        _register(arbiter);
        vm.prank(rando);
        vm.expectRevert(ArbiterRegistry.NotAuthorized.selector);
        registry.deregister(arbiter);
    }

    function test_deregister_NotRegistered() public {
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.NotRegistered.selector, arbiter));
        registry.deregister(arbiter);
    }

    function test_register_AgainAfterDeregister_MintsFreshToken() public {
        uint256 first = _register(arbiter);
        vm.prank(arbiter);
        registry.deregister(arbiter);

        uint256 second = _register(arbiter);
        assertGt(second, first, "re-registration mints a new token");
        assertEq(registry.ownerOf(first), arbiter, "old badge kept");
        assertEq(registry.ownerOf(second), arbiter);
        (bool registered, uint256 tokenId,, ) = registry.arbiters(arbiter);
        assertTrue(registered);
        assertEq(tokenId, second, "mirror points at the latest badge");
    }

    // ── Escrow-only levers ────────────────────────────────────────────────────

    function test_recordResolution_OnlyEscrow() public {
        _register(arbiter);
        vm.prank(rando);
        vm.expectRevert(ArbiterRegistry.NotEscrow.selector);
        registry.recordResolution(arbiter, true);
    }

    function test_recordResolution_NotRegistered() public {
        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.NotRegistered.selector, arbiter));
        registry.recordResolution(arbiter, true);
    }

    function test_recordResolution_PlusOneWithinSla() public {
        _register(arbiter);
        vm.expectEmit(true, false, false, true, address(registry));
        emit ArbiterRegistry.TrustScoreUpdated(arbiter, 1, 1, true);
        vm.prank(address(escrow));
        registry.recordResolution(arbiter, true);

        assertEq(registry.trustScoreOf(arbiter), 1);
        assertEq(registry.resolutionsOf(arbiter), 1);
    }

    function test_recordResolution_MinusTwoWhenLate() public {
        _register(arbiter);
        // first: +1 → score 1
        vm.prank(address(escrow));
        registry.recordResolution(arbiter, true);
        // then: −2 → floored to 0
        vm.expectEmit(true, false, false, true, address(registry));
        emit ArbiterRegistry.TrustScoreUpdated(arbiter, -2, 0, false);
        vm.prank(address(escrow));
        registry.recordResolution(arbiter, false);

        assertEq(registry.trustScoreOf(arbiter), 0, "floored at zero");
        assertEq(registry.resolutionsOf(arbiter), 2);
    }

    function test_recordResolution_FloorAtZeroFromFreshScore() public {
        _register(arbiter);
        vm.prank(address(escrow));
        registry.recordResolution(arbiter, false);
        assertEq(registry.trustScoreOf(arbiter), 0, "0 - 2 floors at 0, never underflows");
    }

    function test_recordResolution_ScoreAccumulates() public {
        _register(arbiter);
        vm.startPrank(address(escrow));
        registry.recordResolution(arbiter, true); // 1
        registry.recordResolution(arbiter, true); // 2
        registry.recordResolution(arbiter, true); // 3
        registry.recordResolution(arbiter, false); // 3 − 2 = 1
        registry.recordResolution(arbiter, true); // 2
        vm.stopPrank();
        assertEq(registry.trustScoreOf(arbiter), 2);
        assertEq(registry.resolutionsOf(arbiter), 5);
    }

    function test_slash_OnlyEscrow() public {
        _register(arbiter);
        vm.prank(rando);
        vm.expectRevert(ArbiterRegistry.NotEscrow.selector);
        registry.slash(arbiter);
    }

    function test_slash_Deregisters() public {
        _register(arbiter);
        vm.expectEmit(true, false, false, false, address(registry));
        emit ArbiterRegistry.ArbiterDeregistered(arbiter);
        vm.prank(address(escrow));
        registry.slash(arbiter);
        assertFalse(registry.isRegistered(arbiter));
    }

    // ── Wiring ────────────────────────────────────────────────────────────────

    function test_setEscrow_OnlyOnce() public {
        address second = makeAddr("secondEscrow");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistry.EscrowAlreadySet.selector, address(escrow)));
        registry.setEscrow(second);
    }

    function test_setEscrow_OnlyOwner() public {
        ArbiterRegistry fresh = new ArbiterRegistry("x", "X", admin);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        fresh.setEscrow(address(escrow));
    }
}
