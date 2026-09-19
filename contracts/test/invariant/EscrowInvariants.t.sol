// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {ArbiterRegistry} from "../../src/ArbiterRegistry.sol";

/**
 * @title EscrowInvariants — the properties that must hold for ANY sequence of
 *        calls, legal or not (PRD §7.4 success criteria).
 *
 *   1. Solvency:    contract balance ≥ Σ unsettled milestone amounts + accrued fees
 *   2. Conservation: every wei that entered via fund() is either still in the
 *                    contract or left via a legitimate payout — nothing leaks,
 *                    nothing is created, nothing is paid twice
 *   3. Fee mirror:  on-chain accruedFees == ghost of every fee the flows accrued
 *   4. No double settle: a settled milestone is terminal forever
 *
 * The Handler makes random sequences of realistic actions (including guaranteed
 * reverts and rando access attempts); Foundry replays them hundreds of times
 * and asserts the invariants after every single call.
 */
contract EscrowInvariants is Test {
    Handler handler;
    Escrow escrow;
    ArbiterRegistry registry;

    function setUp() public {
        handler = new Handler();
        escrow = handler.escrow();
        registry = handler.registry();

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.submit.selector;
        selectors[2] = handler.approve.selector;
        selectors[3] = handler.cancel.selector;
        selectors[4] = handler.openDispute.selector;
        selectors[5] = handler.nominate.selector;
        selectors[6] = handler.adminAssign.selector;
        selectors[7] = handler.resolve.selector;
        selectors[8] = handler.slash.selector;
        selectors[9] = handler.withdrawFees.selector;
        selectors[10] = handler.setFeeBps.selector;
        selectors[11] = handler.chaos.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        // The handler is the ONLY door to the contracts under test: direct
        // fuzz calls into the escrow would move real money around the ghost
        // accounting. (The shrinker proved this matters — it found a direct
        // 76-wei fund() that made the ghosts lie.)
        excludeContract(address(escrow));
        excludeContract(address(registry));
    }

    /// @notice PRD core invariant — the escrow can always cover every liability.
    function invariant_solvency() public view {
        assertGe(
            address(escrow).balance,
            handler.ghost_unsettled() + escrow.accruedFees(),
            "balance must cover unsettled milestones + accrued fees"
        );
    }

    /// @notice Stronger form that this implementation actually achieves:
    ///         balance is EXACTLY the unsettled value plus retained fees.
    function invariant_balanceIsExactlyLiabilities() public view {
        assertEq(address(escrow).balance, handler.ghost_unsettled() + escrow.accruedFees());
    }

    /// @notice Nothing leaks: funded == still-here + paid-out, to the wei.
    function invariant_conservation() public view {
        assertEq(handler.ghost_totalFunded(), address(escrow).balance + handler.ghost_paidOut());
    }

    /// @notice The fee pot mirrors exactly the fees the flows ever accrued.
    function invariant_feePotMirror() public view {
        assertEq(escrow.accruedFees(), handler.ghost_feesAccrued());
    }

    /// @notice Settlement is one-way: terminal milestones never move again.
    function invariant_noDoubleSettle() public view {
        uint256 count = handler.settledCount();
        if (count == 0) return;
        uint256 sample = handler.lastSettledSample(16);
        for (uint256 i = 0; i < sample; i++) {
            uint256 id = handler.settledIdAt(i);
            if (id == 0) break;
            uint8 status = uint8(escrow.milestoneStatus(id));
            assertGe(status, 4, "settled milestones must stay terminal (status >= 4)");
        }
    }
}

/**
 * @title Handler — bounded-actor fuzz driver with ghost accounting.
 * @dev Every state-changing call is wrapped in try/catch: reverts are expected
 *      and healthy (wrong status, wrong actor, closed windows). Ghost variables
 *      are updated ONLY on success, and they mirror the contract's accounting
 *      exactly — which is what makes the invariants above meaningful.
 */
contract Handler is Test {
    Escrow public immutable escrow;
    ArbiterRegistry public immutable registry;

    address public immutable admin = makeAddr("admin");
    address[] clients;
    address[] freelancers;
    address[] arbiters;
    address constant RANDO = address(0xBAD);

    // ── Ghost accounting ──────────────────────────────────────────────────────
    uint256 public ghost_totalFunded;
    uint256 public ghost_paidOut; // payouts + fee withdrawals (wei that left)
    uint256 public ghost_unsettled; // Σ amounts of non-terminal milestones
    uint256 public ghost_feesAccrued; // mirror of escrow.accruedFees()
    uint256 public ghost_settledCount;

    uint256[] createdRing; // recent milestone ids (bounded, for action targeting)
    uint256[] settledRing; // recent settled ids (bounded, for no-double-settle)
    uint256 constant RING = 96;

    constructor() {
        ArbiterRegistry reg = new ArbiterRegistry("OpenLance Arbiter", "OLANCE", admin);
        Escrow esc = new Escrow(reg, admin);
        vm.prank(admin);
        reg.setEscrow(address(esc));
        registry = reg;
        escrow = esc;

        clients.push(makeAddr("clientA"));
        clients.push(makeAddr("clientB"));
        freelancers.push(makeAddr("freelancerA"));
        freelancers.push(makeAddr("freelancerB"));
        arbiters.push(makeAddr("arbiterX"));
        arbiters.push(makeAddr("arbiterY"));

        for (uint256 i = 0; i < clients.length; i++) {
            vm.deal(clients[i], 1_000 ether);
        }
        vm.prank(admin);
        reg.register(arbiters[0]);
        vm.prank(admin);
        reg.register(arbiters[1]);
    }

    // ── Targeting helpers ─────────────────────────────────────────────────────

    function _existingId(uint256 seed) internal view returns (uint256) {
        if (createdRing.length == 0) return 0;
        return createdRing[seed % createdRing.length];
    }

    /// @dev Milestone ids are unique and monotonically increasing, so hashing
    ///      them into a fixed slot spreads writes evenly across the ring.
    function _pushRing(uint256[] storage ring, uint256 id) internal {
        if (ring.length < RING) {
            ring.push(id);
        } else {
            ring[id % RING] = id;
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    function fund(uint256 cSeed, uint256 fSeed, uint256 amountSeed) external {
        address c = clients[cSeed % clients.length];
        address f = freelancers[fSeed % freelancers.length];
        uint256 amount = bound(amountSeed, 1, 2 ether);
        if (c.balance < amount) vm.deal(c, 1_000 ether);

        uint256 id = escrow.nextMilestoneId();
        vm.prank(c);
        try escrow.fund{value: amount}(bytes32(id), f) {
            ghost_totalFunded += amount;
            ghost_unsettled += amount;
            _pushRing(createdRing, id);
        } catch {}
    }

    function submit(uint256 idSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Milestone memory m = escrow.getMilestone(id);
        vm.prank(m.freelancer);
        try escrow.submit(id) {} catch {}
    }

    function approve(uint256 idSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Milestone memory m = escrow.getMilestone(id);
        uint256 fee = (m.amount * m.feeBps) / 10_000;
        vm.prank(m.client);
        try escrow.approve(id) {
            ghost_unsettled -= m.amount;
            ghost_paidOut += m.amount - fee;
            ghost_feesAccrued += fee;
            ghost_settledCount += 1;
            _pushRing(settledRing, id);
        } catch {}
    }

    function cancel(uint256 idSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Milestone memory m = escrow.getMilestone(id);
        vm.prank(m.client);
        try escrow.cancel(id) {
            ghost_unsettled -= m.amount;
            ghost_paidOut += m.amount;
            ghost_settledCount += 1;
            _pushRing(settledRing, id);
        } catch {}
    }

    function openDispute(uint256 idSeed, uint256 whoSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Milestone memory m = escrow.getMilestone(id);
        vm.prank(whoSeed % 2 == 0 ? m.client : m.freelancer);
        try escrow.openDispute(id) {} catch {}
    }

    function nominate(uint256 idSeed, uint256 whoSeed, uint256 arbSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Milestone memory m = escrow.getMilestone(id);
        address candidate = arbiters[arbSeed % arbiters.length];
        vm.prank(whoSeed % 2 == 0 ? m.client : m.freelancer);
        try escrow.nominateArbiter(id, candidate) {} catch {}
    }

    function adminAssign(uint256 idSeed, uint256 arbSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        vm.warp(block.timestamp + 49 hours); // jump past the 48h agreement window
        vm.prank(admin);
        try escrow.adminAssignArbiter(id, arbiters[arbSeed % arbiters.length]) {} catch {}
    }

    function resolve(uint256 idSeed, uint256 outcomeSeed, uint256 timingSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Dispute memory d = escrow.getDispute(id);
        if (d.arbiter == address(0)) return;

        // Sometimes try to stay inside the SLA, sometimes blow it on purpose
        // (late resolutions score −2 — the registry floor-at-zero path).
        if (timingSeed % 3 == 0) {
            vm.warp(block.timestamp + 100 hours);
        }

        uint8 outcome = uint8(outcomeSeed % 3);
        Escrow.Milestone memory m = escrow.getMilestone(id);
        uint256 fee;
        uint256 toFreelancer;
        uint256 toClient;
        if (outcome == uint8(Escrow.Outcome.Release)) {
            fee = (m.amount * m.feeBps) / 10_000;
            toFreelancer = m.amount - fee;
        } else if (outcome == uint8(Escrow.Outcome.Refund)) {
            toClient = m.amount;
        } else {
            uint256 half = m.amount / 2;
            fee = (half * m.feeBps) / 10_000;
            toFreelancer = half - fee;
            toClient = m.amount - half;
        }

        vm.prank(d.arbiter);
        try escrow.resolveDispute(id, outcome) {
            ghost_unsettled -= m.amount;
            ghost_paidOut += toFreelancer + toClient;
            ghost_feesAccrued += fee;
            ghost_settledCount += 1;
            _pushRing(settledRing, id);
        } catch {}
    }

    function slash(uint256 idSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Dispute memory d = escrow.getDispute(id);
        if (d.arbiter == address(0)) return;
        vm.warp(block.timestamp + 100 hours); // sla (72h) + grace (24h) always passed
        try escrow.slashStaleArbiter(id) {} catch {}
        // re-register so the arbiter pool stays alive for later actions
        if (!registry.isRegistered(d.arbiter)) {
            vm.prank(admin);
            try registry.register(d.arbiter) {} catch {}
        }
    }

    function withdrawFees() external {
        uint256 fees = escrow.accruedFees();
        vm.prank(admin);
        try escrow.withdrawFees(admin) {
            ghost_paidOut += fees;
            ghost_feesAccrued = 0;
        } catch {}
    }

    function setFeeBps(uint256 seed) external {
        vm.prank(admin);
        try escrow.setFeeBps(uint16(seed % 600)) {} catch {} // >500 reverts: cap path exercised
    }

    /// @dev Guaranteed-revert pressure from a nobody: every guard gets hammered
    ///      with random roles/states. None of these can succeed EXCEPT the
    ///      permissionless slash — which moves no money, so ghosts stay exact.
    ///      If chaos-slash removes an arbiter, it re-registers them so the
    ///      arbiter pool never starves.
    function chaos(uint256 idSeed, uint256 opSeed, uint256 arbSeed) external {
        uint256 id = _existingId(idSeed);
        if (id == 0) return;
        Escrow.Dispute memory d = escrow.getDispute(id);
        vm.prank(RANDO);
        uint256 op = opSeed % 7;
        if (op == 0) {
            try escrow.approve(id) {} catch {}
        } else if (op == 1) {
            try escrow.cancel(id) {} catch {}
        } else if (op == 2) {
            try escrow.submit(id) {} catch {}
        } else if (op == 3) {
            try escrow.openDispute(id) {} catch {}
        } else if (op == 4) {
            try escrow.resolveDispute(id, uint8(arbSeed % 4)) {} catch {}
        } else if (op == 5) {
            try escrow.nominateArbiter(id, arbiters[arbSeed % arbiters.length]) {} catch {}
        } else {
            try escrow.slashStaleArbiter(id) {} catch {} // permissionless: may succeed, moves no money
            if (d.arbiter != address(0) && !registry.isRegistered(d.arbiter)) {
                vm.prank(admin);
                try registry.register(d.arbiter) {} catch {}
            }
        }
    }

    // ── Views for the invariant contract ──────────────────────────────────────

    function settledCount() external view returns (uint256) {
        return ghost_settledCount;
    }

    function lastSettledSample(uint256 n) external view returns (uint256) {
        return settledRing.length < n ? settledRing.length : n;
    }

    function settledIdAt(uint256 i) external view returns (uint256) {
        if (i >= settledRing.length) return 0;
        return settledRing[i];
    }
}
