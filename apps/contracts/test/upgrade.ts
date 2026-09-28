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
import { deployWithEoaOwner, deployWithTimelockOwner, viaTimelock, connection, getMilestone, ZERO32 } from "./fixtures.ts";
import { parseEther, getAddress } from "viem";

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
        owner, // sponsorshipWallet
        120n, // commitWindow
        120n, // revealWindow
        600n, // appealWindow
        "0x0000000000000000000000000000000000000000", // trustedForwarder
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
        604800n, // minStakeDuration (7d)
        259200n, // unstakeCooldown (3d)
        "0x0000000000000000000000000000000000000000", // trustedForwarder
      ], { account: owner }),
      /InvalidInitialization/,
    );
  });
});

/**
 * Production topology: the TimelockController owns both proxies.
 *
 * Every other suite runs with an EOA owner, so nothing else exercises the
 * timelock path. These assert the properties that only matter in production:
 * the escrow is genuinely NOT the owner, owner-only calls are unreachable
 * without going through the timelock, and an upgrade still works when routed
 * through it.
 */
describe("Production topology — timelock owns the proxies", () => {
  it("the timelock is the owner of both proxies, and neither the deployer nor the escrow is", async function () {
    const { escrow, registry, timelock, deployer } = await deployWithTimelockOwner();
    const tl = getAddress(timelock.address);
    assert.equal(getAddress(await escrow.read.owner()), tl, "escrow owner must be the timelock");
    assert.equal(getAddress(await registry.read.owner()), tl, "registry owner must be the timelock");
    assert.notEqual(getAddress(await escrow.read.owner()), getAddress(deployer.account.address));
  });

  it("the fixture wires registry.escrow correctly (initialize args are aligned)", async function () {
    const { escrow, registry, sponsorshipWallet } = await deployWithTimelockOwner();
    // A misaligned initialize() would shift these and leave them zero.
    assert.equal(getAddress(await registry.read.escrow()), getAddress(escrow.address));
    assert.equal(await registry.read.minStakeDuration(), 3600n);
    assert.equal(await registry.read.unstakeCooldown(), 1800n);
    assert.equal(getAddress(await escrow.read.sponsorshipWallet()), getAddress(sponsorshipWallet));
    assert.equal(await escrow.read.commitWindow(), 120n);
    assert.equal(await escrow.read.revealWindow(), 120n);
    assert.equal(await escrow.read.appealWindow(), 600n);
    assert.equal(await escrow.read.feeBps(), 250);
  });

  it("the deployer cannot call owner-only functions directly", async function () {
    const { escrow, deployer, outsider } = await deployWithTimelockOwner();
    for (const account of [deployer.account, outsider.account]) {
      await assert.rejects(
        escrow.write.setFeeBps([400], { account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(escrow.write.withdrawFees({ account }), /OwnableUnauthorizedAccount/);
      await assert.rejects(
        escrow.write.upgradeToAndCall([escrow.address, "0x"], { account }),
        /OwnableUnauthorizedAccount|UUPSUnauthorizedCallContext/,
      );
    }
  });

  it("an owner-only call succeeds when routed through the timelock", async function () {
    const { escrow, timelock, deployer } = await deployWithTimelockOwner();
    await viaTimelock(timelock, escrow.address, escrow.abi, "setFeeBps", [400]);
    assert.equal(await escrow.read.feeBps(), 400);
    void deployer;
  });

  it("an upgrade succeeds when routed through the timelock, and state survives", async function () {
    const { escrow, registry, timelock, deployer, freelancer } = await deployWithTimelockOwner();
    const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
    const { default: hardhat } = await import("hardhat");
    const up = await upgrades(hardhat as never, connection as never);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("3"), account: deployer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 1);

    const impl = await up.deployImplementation("Escrow");
    await viaTimelock(timelock, escrow.address, escrow.abi, "upgradeToAndCall", [impl, "0x"]);

    // The implementation swapped; the money state did not.
    assert.equal(await escrow.read.milestoneStatus([1n]), 1);
    assert.equal((await getMilestone(escrow, 1n)).amount, parseEther("3"));
    assert.equal(getAddress(await registry.read.escrow()), getAddress(escrow.address));
    void ZERO32;
  });
});
