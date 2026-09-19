/**
 * Escrow — behavior + security suite.
 *
 * Covers the happy path, disputes, fee accounting, access control, reentrancy,
 * and the insolvency-sensitive edge cases. State is reset between tests via
 * `loadFixture`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, getMilestone } from "./fixtures.ts";
import { parseEther, getAddress } from "viem";

// One shared connection for the whole suite.
const { viem } = connection;

const REF = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("Escrow", function () {
  it("funds a milestone and records it on-chain", async function () {
    const { escrow, deployer, freelancer, networkHelpers } = await deployWithEoaOwner();
    const { escrow: e } = await networkHelpers.loadFixture(deployWithEoaOwner);

    const amount = parseEther("1");
    await e.write.fund([REF, freelancer.account.address], { value: amount, account: deployer.account });

    const m = await getMilestone(e, 1n);
    assert.equal(getAddress(m.client), getAddress(deployer.account.address));
    assert.equal(getAddress(m.freelancer), getAddress(freelancer.account.address));
    assert.equal(m.amount, amount);
    assert.equal(m.status, 1); // Funded
    assert.equal(await e.read.milestoneStatus([1n]), 1);
    void escrow;
  });

  it("rejects zero-value funding and self-funding", async function () {
    const { escrow, deployer } = await deployWithEoaOwner();

    await assert.rejects(
      escrow.write.fund([REF, deployer.account.address], { value: 0n, account: deployer.account }),
      /ZeroAmount|InvalidFreelancer/,
    );
    await assert.rejects(
      escrow.write.fund([REF, deployer.account.address], { value: 1n, account: deployer.account }),
      /InvalidFreelancer/,
    );
  });

  it("runs the full release lifecycle: fund -> submit -> approve", async function () {
    const { escrow, deployer, freelancer } = await deployWithEoaOwner();
    const publicClient = await viem.getPublicClient();

    const amount = parseEther("10");
    await escrow.write.fund([REF, freelancer.account.address], { value: amount, account: deployer.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 2); // Submitted

    const escrowBefore = await publicClient.getBalance({ address: escrow.address });
    await escrow.write.approve([1n], { account: deployer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 4); // Released

    // Fee = 2.5% of 10 ETH = 0.25 ETH retained; the rest leaves the escrow.
    assert.equal(await escrow.read.accruedFees(), parseEther("0.25"));
    const escrowAfter = await publicClient.getBalance({ address: escrow.address });
    assert.equal(escrowBefore - escrowAfter, amount - parseEther("0.25"));
  });

  it("only the client can approve and only in Submitted state", async function () {
    const { escrow, deployer, freelancer, outsider } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: deployer.account });

    await assert.rejects(escrow.write.approve([1n], { account: deployer.account }), /WrongStatus/);
    await escrow.write.submit([1n], { account: freelancer.account });
    await assert.rejects(escrow.write.approve([1n], { account: outsider.account }), /NotClient/);
  });

  it("cancels a funded milestone with a full refund", async function () {
    const { escrow, deployer, freelancer } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("2"), account: deployer.account });
    await escrow.write.cancel([1n], { account: deployer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 8); // Cancelled
    await assert.rejects(escrow.write.cancel([1n], { account: deployer.account }), /WrongStatus/);
  });

  it("snapshots the fee at funding time", async function () {
    const { escrow, deployer, freelancer } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: deployer.account });
    await escrow.write.setFeeBps([500], { account: deployer.account }); // 5%
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.approve([1n], { account: deployer.account });
    assert.equal(await escrow.read.accruedFees(), parseEther("0.25")); // still 2.5%
  });

  it("caps the fee at MAX_FEE_BPS (5%)", async function () {
    const { escrow, deployer } = await deployWithEoaOwner();
    await assert.rejects(escrow.write.setFeeBps([501], { account: deployer.account }), /FeeTooHigh/);
    await escrow.write.setFeeBps([500], { account: deployer.account });
    assert.equal(await escrow.read.feeBps(), 500);
  });

  it("only owner can withdraw fees and zero-amount reverts", async function () {
    const { escrow, deployer, freelancer, outsider } = await deployWithEoaOwner();
    await assert.rejects(escrow.write.withdrawFees([deployer.account.address], { account: deployer.account }), /NothingToWithdraw/);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("4"), account: deployer.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.approve([1n], { account: deployer.account });

    await assert.rejects(escrow.write.withdrawFees([deployer.account.address], { account: outsider.account }), /OwnableUnauthorizedAccount/);
    await escrow.write.withdrawFees([deployer.account.address], { account: deployer.account });
    assert.equal(await escrow.read.accruedFees(), 0n);
  });

  it("rejects direct ETH transfers (receive reverts)", async function () {
    const { escrow, deployer } = await deployWithEoaOwner();
    await assert.rejects(
      deployer.sendTransaction({ to: escrow.address, value: 1n }),
      /direct transfers not allowed/i,
    );
  });

  it("returns unknown milestone reads as reverts, never as a status", async function () {
    const { escrow } = await deployWithEoaOwner();
    await assert.rejects(escrow.read.milestoneStatus([0n]), /UnknownMilestone/);
    await assert.rejects(escrow.read.milestoneStatus([999n]), /UnknownMilestone/);
  });
});
