/**
 * Drawdown funding model — lockBudget → fundFromCredit → unlockBudget.
 *
 * The client locks the full job budget once at publish; every milestone of that
 * job is funded from the locked balance (one wallet round, not one per
 * milestone). Per-job balance sheet: reserved + paidOut <= locked; the free
 * balance (locked - paidOut - reserved) is what may be drawn or unlocked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, encodeAbiParameters, parseAbiParameters, keccak256, getAddress } from "viem";
import { deployWithEoaOwner, connection } from "./fixtures.ts";

const { viem } = connection;

const JOB_REF = keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [1n]));
const MILESTONE_A = keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [10n]));
const MILESTONE_B = keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [11n]));
const OTHER_JOB = keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [2n]));
const BUDGET = parseEther("1");

const escrowBalance = async (escrow: any) =>
  (await viem.getPublicClient()).getBalance({ address: escrow.address as `0x${string}` });

describe("Escrow drawdown model", function () {
  it("locks the budget once and draws milestones from it", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    assert.equal(await escrow.read.lockedBudget([JOB_REF]), BUDGET);
    assert.equal(getAddress(await escrow.read.budgetLocker([JOB_REF])), getAddress(client.account.address));

    // Two milestones funded from credit — no ETH attached to either call.
    await escrow.write.fundFromCredit([JOB_REF, MILESTONE_A, freelancer.account.address, parseEther("0.6")], {
      account: client.account,
    });
    await escrow.write.fundFromCredit([JOB_REF, MILESTONE_B, freelancer.account.address, parseEther("0.4")], {
      account: client.account,
    });

    assert.equal(await escrow.read.reservedBudget([JOB_REF]), BUDGET);
    assert.equal(await escrow.read.paidOutBudget([JOB_REF]), 0n);
    assert.equal((await escrow.read.getMilestone([1n])).amount, parseEther("0.6"));
    assert.equal((await escrow.read.getMilestone([2n])).amount, parseEther("0.4"));
  });

  it("rejects a draw that would exceed the free balance, and only the locker may draw", async function () {
    const { escrow, client, freelancer, outsider } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    await escrow.write.fundFromCredit([JOB_REF, MILESTONE_A, freelancer.account.address, parseEther("0.6")], {
      account: client.account,
    });

    // 0.6 + 0.5 > 1.0 free (0.4)
    await assert.rejects(
      () => escrow.write.fundFromCredit([JOB_REF, MILESTONE_B, freelancer.account.address, parseEther("0.5")], { account: client.account }),
      /InsufficientBudget/,
    );

    await assert.rejects(
      () => escrow.write.fundFromCredit([JOB_REF, MILESTONE_B, freelancer.account.address, parseEther("0.4")], { account: outsider.account }),
      /NotClient/,
    );
  });

  it("cannot lock the same job twice, and cannot draw from an unlocked job", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    await assert.rejects(
      () => escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account }),
      /BudgetAlreadyLocked/,
    );

    await assert.rejects(
      () => escrow.write.fundFromCredit([OTHER_JOB, MILESTONE_A, freelancer.account.address, parseEther("0.1")], { account: client.account }),
      /NoBudgetLocked/,
    );
  });

  it("releases a cancelled milestone's reservation and pays the refund", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    // Fund 0.7 then cancel it: the refund is paid out and the reservation frees,
    // so the free balance is 0.3 (the cancelled draw is already gone).
    await escrow.write.fundFromCredit([JOB_REF, MILESTONE_A, freelancer.account.address, parseEther("0.7")], {
      account: client.account,
    });
    assert.equal(await escrow.read.reservedBudget([JOB_REF]), parseEther("0.7"));

    const before = await escrowBalance(escrow);
    await escrow.write.cancel([1n], { account: client.account });
    assert.equal(await escrow.read.reservedBudget([JOB_REF]), 0n);
    assert.equal(await escrow.read.paidOutBudget([JOB_REF]), parseEther("0.7"));
    assert.equal(await escrowBalance(escrow), before - parseEther("0.7"));

    // Only the free 0.3 is unlockable.
    await escrow.write.unlockBudget([JOB_REF, parseEther("0.3")], { account: client.account });
    assert.equal(await escrowBalance(escrow), before - BUDGET);
    await assert.rejects(
      () => escrow.write.unlockBudget([JOB_REF, parseEther("0.1")], { account: client.account }),
      /InsufficientBudget/,
    );
  });

  it("clamps unlocks to the free balance", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();
    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    await escrow.write.fundFromCredit([JOB_REF, MILESTONE_A, freelancer.account.address, parseEther("0.6")], {
      account: client.account,
    });

    // Free = 1.0 - 0.6 reserved = 0.4; asking for more must revert.
    await assert.rejects(
      () => escrow.write.unlockBudget([JOB_REF, parseEther("0.5")], { account: client.account }),
      /InsufficientBudget/,
    );

    const before = await escrowBalance(escrow);
    await escrow.write.unlockBudget([JOB_REF, parseEther("0.4")], { account: client.account });
    assert.equal(await escrowBalance(escrow), before - parseEther("0.4"));

    // The free balance is now exhausted — the reserved 0.6 backs the live
    // milestone, so no further draw is possible until it settles.
    await assert.rejects(
      () => escrow.write.fundFromCredit([JOB_REF, MILESTONE_B, freelancer.account.address, parseEther("0.4")], { account: client.account }),
      /InsufficientBudget/,
    );
    assert.equal(await escrow.read.reservedBudget([JOB_REF]), parseEther("0.6"));
  });

  it("funds every milestone in one batch from the locked budget (award flow)", async function () {
    const { escrow, client, freelancer, outsider } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });

    const refs = [MILESTONE_A, MILESTONE_B];
    const frees = [freelancer.account.address, freelancer.account.address];
    const amounts = [parseEther("0.6"), parseEther("0.4")];

    await escrow.write.fundAllFromCredit([JOB_REF, refs, frees, amounts], { account: client.account });

    assert.equal(await escrow.read.reservedBudget([JOB_REF]), BUDGET);
    assert.equal((await escrow.read.getMilestone([1n])).amount, parseEther("0.6"));
    assert.equal((await escrow.read.getMilestone([2n])).amount, parseEther("0.4"));

    // All-or-nothing: a batch that overdraws the free balance reverts entirely.
    await assert.rejects(
      () => escrow.write.fundAllFromCredit([OTHER_JOB, refs, frees, amounts], { account: client.account }),
      /NoBudgetLocked/,
    );

    // Only the locker may batch-fund.
    await assert.rejects(
      () => escrow.write.fundAllFromCredit([JOB_REF, refs, frees, amounts], { account: outsider.account }),
      /NotClient/,
    );

    // Mismatched array lengths are rejected before any state change.
    await assert.rejects(
      () => escrow.write.fundAllFromCredit([JOB_REF, refs, [freelancer.account.address], amounts], { account: client.account }),
      /BadBatch/,
    );
  });

  it("rejects a batch that exceeds the free balance without partially funding", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();

    await escrow.write.lockBudget([JOB_REF], { value: BUDGET, account: client.account });
    // 0.7 + 0.5 = 1.2 > 1.0 → the whole batch must revert, nothing reserved.
    await assert.rejects(
      () => escrow.write.fundAllFromCredit(
        [JOB_REF, [MILESTONE_A, MILESTONE_B], [freelancer.account.address, freelancer.account.address], [parseEther("0.7"), parseEther("0.5")]],
        { account: client.account },
      ),
      /InsufficientBudget/,
    );
    assert.equal(await escrow.read.reservedBudget([JOB_REF]), 0n);
  });
});
