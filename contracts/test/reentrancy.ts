/**
 * Reentrancy + accounting invariants.
 *
 * The escrow is the money authority; these tests prove a malicious recipient
 * cannot extract funds twice or leave the contract insolvent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection } from "./fixtures.ts";
import { parseEther } from "viem";

const { viem } = connection;
const REF = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("Escrow — reentrancy & accounting", () => {
  it("a reentrant freelancer cannot drain the escrow (guard + CEI)", async function () {
    const { escrow, client } = await deployWithEoaOwner();
    const publicClient = await viem.getPublicClient();

    // Deploy the attacker as the freelancer.
    const attacker = await viem.deployContract("ReentrancyAttacker", [escrow.address]);

    await escrow.write.fund([REF, attacker.address], { value: parseEther("10"), account: client.account });
    await attacker.write.submitWork([1n]);

    // Approve only marks claimable (no payout to reenter through).
    await escrow.write.approve([1n], { account: client.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 4); // Released
    assert.equal(await escrow.read.claimable([1n]), parseEther("9.75"));

    // withdrawMilestone triggers _pay -> attacker.receive -> reenter withdraw
    // -> guard reverts -> outer _pay bubbles TransferFailed: all reverted.
    await assert.rejects(attacker.write.pull([1n]), /TransferFailed/);

    // Nothing moved: still Released + claimable, fee accrued, escrow whole.
    assert.equal(await escrow.read.milestoneStatus([1n]), 4); // Released
    assert.equal(await escrow.read.claimable([1n]), parseEther("9.75"));
    assert.equal(await escrow.read.accruedFees(), parseEther("0.25"));
    assert.equal(await publicClient.getBalance({ address: escrow.address }), parseEther("10"));
  });

  it("escrow balance always equals unsettled milestones + accrued fees", async function () {
    const { escrow, deployer, client, freelancer } = await deployWithEoaOwner();
    const publicClient = await viem.getPublicClient();

    // Two milestones funded.
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("4"), account: client.account });
    await escrow.write.fund([`0x${"cd".repeat(32)}`, freelancer.account.address], { value: parseEther("6"), account: client.account });
    assert.equal(await publicClient.getBalance({ address: escrow.address }), parseEther("10"));

    // Settle the first: 4 ETH - 2.5% fee. Approve marks claimable (no payout),
    // so the escrow still holds the full 10 until the freelancer pulls.
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.approve([1n], { account: client.account });
    const fee = parseEther("0.1"); // 2.5% of 4
    assert.equal(await escrow.read.accruedFees(), fee);
    assert.equal(await escrow.read.claimable([1n]), parseEther("3.9"));
    assert.equal(await publicClient.getBalance({ address: escrow.address }), parseEther("10"));

    // Withdraw fees: accruedFees -> 0, escrow holds unsettled 6 + claimable 3.9.
    await escrow.write.withdrawFees([deployer.account.address], { account: deployer.account });
    assert.equal(await escrow.read.accruedFees(), 0n);
    assert.equal(await publicClient.getBalance({ address: escrow.address }), parseEther("9.9"));

    // Freelancer pulls: escrow holds exactly the unsettled 6.
    await escrow.write.withdrawMilestone([1n], { account: freelancer.account });
    assert.equal(await publicClient.getBalance({ address: escrow.address }), parseEther("6"));
  });

  it("a milestone cannot be settled twice", async function () {
    const { escrow, client, freelancer } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.approve([1n], { account: client.account });

    await assert.rejects(escrow.write.approve([1n], { account: client.account }), /WrongStatus/);
    await assert.rejects(escrow.write.cancel([1n], { account: client.account }), /WrongStatus/);
    // Opening a dispute on a released milestone is not allowed (funding fee + no arbiters
    // would also revert, but NotDisputable is checked first).
    await assert.rejects(
      escrow.write.openDispute([1n], { value: parseEther("0.05"), account: client.account }),
      /NotDisputable/,
    );
  });
});
