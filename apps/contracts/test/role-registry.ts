/**
 * RoleRegistry — the one free write, the paid write, and the arbiter exit gate.
 *
 * The invariant that matters most here is NEGATIVE: a wallet that has taken the
 * arbiter seat and staked collateral must not be able to walk out of the seat
 * for a fee while the stake is still committed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hardhat, { network } from "hardhat";
import { parseEther } from "viem";
import { connection, MIN_STAKE, MIN_SCORE, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN } from "./fixtures.ts";

const { viem, networkHelpers } = connection;

const ROLE = { None: 0, Client: 1, Freelancer: 2, Arbiter: 3 } as const;
const FEE = parseEther("0.01");

async function upgradesApi() {
  const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
  return upgrades(hardhat as never, connection as never);
}

/**
 * RoleRegistry + a real ArbiterRegistry, so the exit gate is exercised against
 * the contract it will actually read in production rather than a stand-in.
 * `arbiterRegistry: address(0)` when `wire` is false — the unset case.
 */
async function deployRoles({ wire = true } = {}) {
  const wallets = await viem.getWalletClients();
  const [deployer, alice, bob] = wallets;
  const owner = deployer.account.address;
  const forwarder = await viem.deployContract("SponsorshipForwarder", []);
  const up = await upgradesApi();

  const arbiters = await up.deployProxy(
    "ArbiterRegistry",
    ["OpenLance Arbiter", "OLANCE", owner, MIN_STAKE, MIN_SCORE, owner, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN, forwarder.address],
    { kind: "uups" },
  );
  const roles = await up.deployProxy(
    "RoleRegistry",
    [owner, FEE, owner, wire ? arbiters.address : `0x${"0".repeat(40)}`, forwarder.address],
    { kind: "uups" },
  );

  return { viem, networkHelpers, roles: roles as any, arbiters: arbiters as any, deployer, alice, bob, owner };
}

describe("RoleRegistry — the one free write", () => {
  it("claims a seat for free and refuses a second claim", async () => {
    const { roles, alice } = await deployRoles();
    const a = alice.account.address;

    assert.equal(await roles.read.roleOf([a]), ROLE.None);
    assert.equal(await roles.read.isClaimed([a]), false);

    // Free: no value attached, and the wallet keeps its whole balance.
    await roles.write.claim([ROLE.Freelancer], { account: alice.account });
    assert.equal(await roles.read.roleOf([a]), ROLE.Freelancer);
    assert.equal(await roles.read.isClaimed([a]), true);

    await assert.rejects(roles.write.claim([ROLE.Client], { account: alice.account }), /AlreadyClaimed/);
  });

  it("refuses to claim the empty seat", async () => {
    const { roles, alice } = await deployRoles();
    await assert.rejects(roles.write.claim([ROLE.None], { account: alice.account }), /InvalidRole/);
  });
});

describe("RoleRegistry — the paid write", () => {
  it("moves a seat for exactly the fee and pays the treasury", async () => {
    const { roles, deployer, alice } = await deployRoles();
    await roles.write.claim([ROLE.Client], { account: alice.account });

    const pc = await viem.getPublicClient();
    const before = await pc.getBalance({ address: deployer.account.address });
    await roles.write.switchRole([ROLE.Freelancer], { value: FEE, account: alice.account });
    const after = await pc.getBalance({ address: deployer.account.address });

    assert.equal(await roles.read.roleOf([alice.account.address]), ROLE.Freelancer);
    assert.equal(await roles.read.totalFees(), FEE);
    // Fee forwarded to the treasury (the deployer here), not retained.
    assert.equal(after - before, FEE);
  });

  it("rejects an underpayment and a switch before any claim", async () => {
    const { roles, bob, alice } = await deployRoles();
    await assert.rejects(
      roles.write.switchRole([ROLE.Client], { value: FEE - 1n, account: alice.account }),
      /NotClaimed/,
    );

    await roles.write.claim([ROLE.Client], { account: alice.account });
    await assert.rejects(
      roles.write.switchRole([ROLE.Freelancer], { value: FEE - 1n, account: alice.account }),
      /FeeBelowRequired/,
    );
    await assert.rejects(roles.write.switchRole([ROLE.Freelancer], { value: FEE, account: bob.account }), /NotClaimed/);
  });

  it("refuses a no-op switch", async () => {
    const { roles, alice } = await deployRoles();
    await roles.write.claim([ROLE.Freelancer], { account: alice.account });
    await assert.rejects(roles.write.switchRole([ROLE.Freelancer], { value: FEE, account: alice.account }), /SameRole/);
  });

  it("closes the direct-transfer path", async () => {
    const { roles, deployer } = await deployRoles();
    await assert.rejects(
      deployer.sendTransaction({ to: roles.address, value: parseEther("1") }),
      /DirectTransferNotAllowed/,
    );
  });
});

describe("RoleRegistry — the arbiter exit gate", () => {
  it("blocks leaving the arbiter seat while stake is committed, and allows it once withdrawn", async () => {
    const { roles, arbiters, networkHelpers: helpers, alice } = await deployRoles();
    await roles.write.claim([ROLE.Arbiter], { account: alice.account });
    await arbiters.write.registerArbiter({ value: MIN_STAKE, account: alice.account });

    // The whole point: a paid tx must not buy a way out of staked collateral.
    await assert.rejects(
      roles.write.switchRole([ROLE.Client], { value: FEE, account: alice.account }),
      /ArbiterHasStake/,
    );

    // Age the stake past the request gate, then exit fully.
    await helpers.time.increase(Number(UNSTAKE_COOLDOWN) + 1);
    await arbiters.write.requestUnstake({ account: alice.account });
    await arbiters.write.withdrawStake({ account: alice.account });

    await roles.write.switchRole([ROLE.Client], { value: FEE, account: alice.account });
    assert.equal(await roles.read.roleOf([alice.account.address]), ROLE.Client);
  });

  it("fails CLOSED when the stake read is unavailable", async () => {
    // Unset dependency: the gate reverts rather than assuming a zero stake.
    const { roles, alice } = await deployRoles({ wire: false });
    await roles.write.claim([ROLE.Arbiter], { account: alice.account });
    await assert.rejects(
      roles.write.switchRole([ROLE.Client], { value: FEE, account: alice.account }),
      /StakeReadUnavailable/,
    );
  });

  it("keeps the arbiter dependency one-shot", async () => {
    const { roles, arbiters, deployer } = await deployRoles();
    await assert.rejects(
      roles.write.setArbiterRegistry([arbiters.address], { account: deployer.account }),
      /ArbiterRegistryAlreadySet/,
    );
  });
});
