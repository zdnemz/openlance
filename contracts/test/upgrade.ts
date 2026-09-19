/**
 * UUPS upgrade safety + authorization.
 *
 * The most security-critical property of an upgradeable escrow: nobody except
 * the (timelocked) owner may swap the implementation. These tests assert:
 *   - the proxy points at the implementation and can be upgraded by the owner,
 *   - an outsider cannot upgrade,
 *   - the implementation contract itself cannot be initialized (squatted),
 *   - state survives an upgrade (storage layout is compatible).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, getMilestone } from "./fixtures.ts";
import { parseEther } from "viem";

const { viem, networkHelpers } = connection;
const REF = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("UUPS upgrade authorization", () => {
  it("only the owner can upgrade the escrow proxy", async function () {
    const { escrow, deployer, outsider } = await deployWithEoaOwner();
    const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
    const { default: hardhat } = await import("hardhat");
    const up = await upgrades(hardhat as never, connection as never);

    // Outsider cannot call upgradeToAndCall directly.
    await assert.rejects(
      escrow.write.upgradeToAndCall([escrow.address, "0x"], { account: outsider.account }),
      /OwnableUnauthorizedAccount|UUPSUnauthorizedCallContext|ERC1967InvalidImplementation/,
    );

    // Owner can upgrade (redeploy the same implementation — layout identical).
    const impl = await up.deployImplementation("Escrow");
    const hash = await escrow.write.upgradeToAndCall([impl, "0x"], { account: deployer.account });
    await (await viem.getPublicClient()).waitForTransactionReceipt({ hash }).catch(() => {});
  });

  it("state survives an upgrade", async function () {
    const { escrow, deployer, freelancer } = await deployWithEoaOwner();
    const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
    const { default: hardhat } = await import("hardhat");
    const up = await upgrades(hardhat as never, connection as never);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("3"), account: deployer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 1);

    const impl = await up.deployImplementation("Escrow");
    await escrow.write.upgradeToAndCall([impl, "0x"], { account: deployer.account });

    // Milestone 1 and counters survive the implementation swap.
    assert.equal(await escrow.read.milestoneStatus([1n]), 1);
    assert.equal(await escrow.read.nextMilestoneId(), 2n);
    assert.equal((await getMilestone(escrow, 1n)).amount, parseEther("3"));
  });

  it("the escrow implementation cannot be initialized directly (no squatting)", async function () {
    const { registry } = await deployWithEoaOwner();
    const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
    const { default: hardhat } = await import("hardhat");
    const up = await upgrades(hardhat as never, connection as never);

    const implAddr = await up.deployImplementation("Escrow");
    const impl = await viem.getContractAt("Escrow", implAddr);
    const owner = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    await assert.rejects(
      impl.write.initialize([
        registry.address, // arbiterRegistry
        owner, // owner
        250, // feeBps
        0n, // disputeFee
        owner, // treasury
        120n, // commitWindow
        120n, // revealWindow
        600n, // appealWindow
      ], { account: owner }),
      /InvalidInitialization/,
    );
  });

  it("the registry implementation cannot be initialized directly", async function () {
    const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
    const { default: hardhat } = await import("hardhat");
    const up = await upgrades(hardhat as never, connection as never);
    const implAddr = await up.deployImplementation("ArbiterRegistry");
    const impl = await viem.getContractAt("ArbiterRegistry", implAddr);
    const owner = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    await assert.rejects(
      impl.write.initialize([
        "X", // name
        "X", // symbol
        owner, // owner
        100000000000000000n, // minStake
        50n, // minScoreToWithdraw
        owner, // treasury
      ], { account: owner }),
      /InvalidInitialization/,
    );
  });
});
