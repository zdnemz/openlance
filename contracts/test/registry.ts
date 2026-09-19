/**
 * ArbiterRegistry — staking, trust score, locking and slashing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, MIN_STAKE, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN } from "./fixtures.ts";
import { parseEther } from "viem";

const { viem, networkHelpers } = connection;

describe("ArbiterRegistry — registration & staking", () => {
  it("self-registers with a stake, score 100, locked badge", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });

    assert.equal(await registry.read.isRegistered([a.account.address]), true);
    assert.equal(await registry.read.trustScoreOf([a.account.address]), 100n);
    assert.equal(await registry.read.stakeOf([a.account.address]), MIN_STAKE);
    assert.equal(await registry.read.locked([1n]), true);
    // Freshly staked: not yet eligible — the min-stake-duration clock is running.
    assert.equal(await registry.read.isEligible([a.account.address]), false);
    // …and flips to eligible once the duration has elapsed.
    await networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    assert.equal(await registry.read.isEligible([a.account.address]), true);
  });

  it("rejects a stake below the minimum", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await assert.rejects(
      registry.write.registerArbiter({ value: MIN_STAKE - 1n, account: a.account }),
      /StakeBelowMinimum/,
    );
  });

  it("rejects double registration", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await assert.rejects(
      registry.write.registerArbiter({ value: MIN_STAKE, account: a.account }),
      /AlreadyRegistered/,
    );
  });

  it("owner can register an arbiter and seed their stake", async function () {
    const { registry, deployer, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.register([a.account.address], { value: MIN_STAKE, account: deployer.account });
    assert.equal(await registry.read.isRegistered([a.account.address]), true);
    assert.equal(await registry.read.stakeOf([a.account.address]), MIN_STAKE);
  });

  it("owner-only register reverts for a non-owner", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await assert.rejects(
      registry.write.register([a.account.address], { value: MIN_STAKE, account: a.account }),
      /OwnableUnauthorizedAccount/,
    );
  });

  it("accepts extra stake via addStake", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await registry.write.addStake({ value: parseEther("0.2"), account: a.account });
    assert.equal(await registry.read.stakeOf([a.account.address]), MIN_STAKE + parseEther("0.2"));
  });
});

describe("ArbiterRegistry — time-based staking rules", () => {
  it("an arbiter is NOT eligible until minStakeDuration has elapsed", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });

    assert.equal(await registry.read.minStakeDuration(), MIN_STAKE_DURATION);
    assert.equal(await registry.read.isEligible([a.account.address]), false);

    // Just short of the window — still benched.
    await networkHelpers.time.increase(Number(MIN_STAKE_DURATION) - 10);
    assert.equal(await registry.read.isEligible([a.account.address]), false);

    // Cross the threshold — eligible.
    await networkHelpers.time.increase(11);
    assert.equal(await registry.read.isEligible([a.account.address]), true);
    assert.ok(
      (await registry.read.eligibleAt([a.account.address])) > 0n,
      "eligibleAt should be a concrete timestamp",
    );
  });

  it("withdraw is blocked until the unstake cooldown elapses", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await registry.write.requestUnstake({ account: a.account });

    // Cooldown not yet elapsed → withdraw reverts.
    await assert.rejects(registry.write.withdrawStake({ account: a.account }), /UnstakeCooldownActive/);
    const readyAt = await registry.read.unstakeReadyAt([a.account.address]);
    assert.ok(readyAt > 0n, "unstakeReadyAt should be set while a request is pending");

    // Still blocked right before the window closes.
    await networkHelpers.time.increase(Number(UNSTAKE_COOLDOWN) - 10);
    await assert.rejects(registry.write.withdrawStake({ account: a.account }), /UnstakeCooldownActive/);

    // After the cooldown → withdraw succeeds.
    await networkHelpers.time.increase(11);
    await registry.write.withdrawStake({ account: a.account });
    assert.equal(await registry.read.isRegistered([a.account.address]), false);
  });

  it("cancelUnstake clears the cooldown clock", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await registry.write.requestUnstake({ account: a.account });
    assert.ok((await registry.read.unstakeReadyAt([a.account.address])) > 0n);

    await registry.write.cancelUnstake({ account: a.account });
    assert.equal(await registry.read.unstakeReadyAt([a.account.address]), 0n);
  });

  it("only the owner can retune the duration / cooldown", async function () {
    const { registry, owner, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await assert.rejects(
      registry.write.setMinStakeDuration([7200n], { account: a.account }),
      /OwnableUnauthorizedAccount/,
    );
    await registry.write.setMinStakeDuration([7200n], { account: (await viem.getWalletClients())[0]!.account });
    assert.equal(await registry.read.minStakeDuration(), 7200n);
    await registry.write.setUnstakeCooldown([900n], { account: (await viem.getWalletClients())[0]!.account });
    assert.equal(await registry.read.unstakeCooldown(), 900n);
    void owner;
  });
});

describe("ArbiterRegistry — unstake / withdraw / lock", () => {
  it("requestUnstake + withdrawStake returns the collateral", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });

    const pc = await viem.getPublicClient();
    await registry.write.requestUnstake({ account: a.account });
    // Wait out the unstake cooldown before the collateral is released.
    await networkHelpers.time.increase(Number(UNSTAKE_COOLDOWN) + 1);
    const before = await pc.getBalance({ address: a.account.address });
    await registry.write.withdrawStake({ account: a.account });
    const after = await pc.getBalance({ address: a.account.address });

    assert.ok(after > before, "collateral should return to the arbiter");
    assert.equal(await registry.read.isRegistered([a.account.address]), false);
    assert.equal(await registry.read.stakeOf([a.account.address]), 0n);
  });

  it("cannot withdraw without first requesting", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await assert.rejects(registry.write.withdrawStake({ account: a.account }), /UnstakeNotRequested/);
  });

  it("cancelUnstake rejoins the pool", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1); // clear the min-stake clock
    await registry.write.requestUnstake({ account: a.account });
    assert.equal(await registry.read.isEligible([a.account.address]), false);
    await registry.write.cancelUnstake({ account: a.account });
    assert.equal(await registry.read.isEligible([a.account.address]), true);
  });
});

describe("ArbiterRegistry — scoring, locking, slashing (via escrow hooks)", () => {
  // The score hooks are escrow-only; tests impersonate the wired escrow address.
  async function withEscrow(escrow: any, fn: () => Promise<void>) {
    await connection.networkHelpers.impersonateAccount(escrow.address);
    await connection.networkHelpers.setBalance(escrow.address, parseEther("100"));
    try {
      await fn();
    } finally {
      await connection.networkHelpers.stopImpersonatingAccount(escrow.address);
    }
  }

  it("applies a majority reward (+5, capped) and a minority penalty (-10)", async function () {
    const { registry, escrow, arbiters } = await deployWithEoaOwner();
    const [a, b] = [arbiters[0]!, arbiters[1]!];
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await registry.write.registerArbiter({ value: MIN_STAKE, account: b.account });

    await withEscrow(escrow, async () => {
      await registry.write.applyScoreChange([a.account.address, 5n, 1], { account: escrow.address });
      await registry.write.applyScoreChange([b.account.address, -10n, 2], { account: escrow.address });
    });

    assert.equal(await registry.read.trustScoreOf([a.account.address]), 100n); // capped at MAX
    assert.equal(await registry.read.trustScoreOf([b.account.address]), 90n);
  });

  it("locks the stake and benches the arbiter when score < n", async function () {
    const { registry, escrow, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });

    // Drop below the threshold (50) with repeated misses (-15 each).
    await withEscrow(escrow, async () => {
      for (let i = 0; i < 3; i++) {
        await registry.write.applyScoreChange([a.account.address, -15n, 3], { account: escrow.address });
      }
    });
    assert.equal(await registry.read.trustScoreOf([a.account.address]), 55n);
    assert.equal(await registry.read.isLocked([a.account.address]), false); // still >= 50

    await withEscrow(escrow, async () => {
      await registry.write.applyScoreChange([a.account.address, -15n, 3], { account: escrow.address });
    });
    assert.equal(await registry.read.trustScoreOf([a.account.address]), 40n); // < 50
    assert.equal(await registry.read.isLocked([a.account.address]), true);
    assert.equal(await registry.read.isEligible([a.account.address]), false);

    await assert.rejects(registry.write.requestUnstake({ account: a.account }), /StakeIsLocked/);
  });

  it("slashes the full stake to the treasury when score reaches 0", async function () {
    const { registry, escrow, arbiters, treasury } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });

    const pc = await viem.getPublicClient();
    const treasuryBefore = await pc.getBalance({ address: treasury });

    await withEscrow(escrow, async () => {
      for (let i = 0; i < 7; i++) {
        const s = await registry.read.trustScoreOf([a.account.address]);
        if (s === 0n) break;
        await registry.write.applyScoreChange([a.account.address, -15n, 3], { account: escrow.address });
      }
    });

    assert.equal(await registry.read.trustScoreOf([a.account.address]), 0n);
    assert.equal(await registry.read.stakeOf([a.account.address]), 0n);
    assert.equal(await registry.read.isRegistered([a.account.address]), false);
    const treasuryAfter = await pc.getBalance({ address: treasury });
    assert.equal(treasuryAfter - treasuryBefore, MIN_STAKE); // collateral slashed to treasury
  });

  it("only the escrow can move scores", async function () {
    const { registry, arbiters } = await deployWithEoaOwner();
    const a = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: a.account });
    await assert.rejects(
      registry.write.applyScoreChange([a.account.address, 5n, 1], { account: a.account }),
      /NotEscrow/,
    );
  });

  it("cannot unstake while handling an active dispute", async function () {
    const { registry, escrow, client, freelancer, arbiters } = await deployWithEoaOwner();
    for (const w of arbiters.slice(0, 3)) await registry.write.registerArbiter({ value: MIN_STAKE, account: w.account });
    await networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1); // make the roster selectable
    await escrow.write.fund([`0x${"aa".repeat(32)}`, freelancer.account.address], { value: parseEther("1"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { value: parseEther("0.05"), account: client.account });

    const r = (await escrow.read.getRound([1n, 0])) as readonly unknown[];
    const selected = (r[0] as `0x${string}`[]).slice(0, Number(r[1]));
    const map = new Map(arbiters.map((w) => [w.account.address.toLowerCase(), w]));
    const busy = map.get(selected[0]!.toLowerCase())!;

    await assert.rejects(registry.write.requestUnstake({ account: busy.account }), /StillHandlingDispute/);
  });
});
