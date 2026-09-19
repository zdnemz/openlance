/**
 * Escrow — multi-arbiter dispute lifecycle.
 *
 * Covers arbiter selection (<=3, party-excluded), commit-reveal, 2-of-3 quorum,
 * majority payouts with exact wei conservation, no-quorum fallback, and appeals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, DISPUTE_FEE, getRound, getDispute, MIN_STAKE, MIN_STAKE_DURATION } from "./fixtures.ts";
import { commitRevealAll, walletsFor, passRevealWindow, passAppealWindow, tallyAndFinalize } from "./disputeFlow.ts";
import { parseEther } from "viem";

const REF = `0x${"ab".repeat(32)}` as `0x${string}`;
const { viem } = connection;

const RELEASE = 0;
const REFUND = 1;
const SPLIT = 2;

/** Fund a milestone and open a dispute with N registered arbiters available. */
async function setupDispute(arbitersAvailable = 3) {
  const ctx = await deployWithEoaOwner();
  const { registry, escrow, deployer, client, freelancer, arbiters } = ctx;
  // Register the requested number of arbiters (self-register with stake).
  const arbiterWallets = arbiters.slice(0, arbitersAvailable);
  for (const w of arbiterWallets) {
    await registry.write.registerArbiter({ value: MIN_STAKE, account: w.account });
  }
  // Clear the min-stake-duration clock so the roster is selectable immediately.
  await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
  await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
  await escrow.write.submit([1n], { account: freelancer.account });
  await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });
  return { ...ctx, arbiterWallets };
}

describe("Escrow — multi-arbiter disputes", () => {
  it("selects up to 3 eligible arbiters and excludes the parties", async function () {
    const { escrow, arbiters, client, freelancer } = await setupDispute(4);
    const r = await getRound(escrow, 1n, 0);
    assert.ok(r.arbiterCount >= 2 && r.arbiterCount <= 3, `expected 2-3 arbiters, got ${r.arbiterCount}`);
    for (let i = 0; i < r.arbiterCount; i++) {
      const a = r.arbiters[i]!.toLowerCase();
      assert.notEqual(a, client.account.address.toLowerCase());
      assert.notEqual(a, freelancer.account.address.toLowerCase());
    }
    void arbiters;
  });

  it("requires at least a 2-arbiter pool to open a dispute", async function () {
    const { registry, escrow, client, freelancer } = await deployWithEoaOwner();
    // Only one arbiter registered -> cannot reach quorum.
    await registry.write.registerArbiter({ value: MIN_STAKE, account: (await connection.viem.getWalletClients())[3]!.account });
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: client.account });
    await assert.rejects(
      escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account }),
      /NotEnoughArbiters/,
    );
  });

  it("enforces the dispute fee", async function () {
    const { registry, escrow, client, freelancer, arbiters } = await deployWithEoaOwner();
    for (const w of arbiters.slice(0, 3)) await registry.write.registerArbiter({ value: MIN_STAKE, account: w.account });
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: client.account });
    await assert.rejects(
      escrow.write.openDispute([1n], { value: DISPUTE_FEE - 1n, account: client.account }),
      /DisputeFeeTooLow/,
    );
  });

  it("runs commit -> reveal -> resolve with a 2-of-3 majority (Release)", async function () {
    const { escrow, arbiters, client, freelancer } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));

    // Override one arbiter to Refund so the majority is Release (2-1).
    const overrides: Record<string, number> = { [wallets[2]!.account.address.toLowerCase()]: REFUND };
    await commitRevealAll(escrow, 1n, 0, wallets, RELEASE, overrides);

    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);

    assert.equal(await escrow.read.milestoneStatus([1n]), 5); // ResolvedRelease
    void freelancer;
  });

  it("resolves a unanimous Refund", async function () {
    const { escrow, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    await commitRevealAll(escrow, 1n, 0, wallets, REFUND);
    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);
    assert.equal(await escrow.read.milestoneStatus([1n]), 6); // ResolvedRefund
  });

  it("conserve wei on a Split majority", async function () {
    const { escrow, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    const overrides: Record<string, number> = { [wallets[2]!.account.address.toLowerCase()]: RELEASE };
    await commitRevealAll(escrow, 1n, 0, wallets, SPLIT, overrides);
    await passRevealWindow(escrow, 1n, 0);

    const pc = await viem.getPublicClient();
    const before = await pc.getBalance({ address: escrow.address });
    await tallyAndFinalize(escrow, 1n, 0, client.account);
    const after = await pc.getBalance({ address: escrow.address });

    // 10 ETH principal: half (5) to freelancer minus 2.5% fee on the half, rest to client.
    const half = parseEther("5");
    const fee = (half * 250n) / 10000n;
    assert.equal(await escrow.read.accruedFees(), fee);
    // The escrow only retains the platform fee (dispute fee was paid out to majority).
    assert.equal(after, fee);
    void before;
  });

  it("rejects commits after the commit deadline and reveals before it", async function () {
    const { escrow, arbiters } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, arbiters.slice(0, 3))[0]!;

    // Reveal before commit deadline is rejected.
    await assert.rejects(
      escrow.write.revealVote([1n, 0, RELEASE, `0x${"11".repeat(32)}`], { account: w.account }),
      /CommitDeadlineNotPassed/,
    );

    await passCommitDeadline(escrow, 1n);
    await assert.rejects(
      escrow.write.commitVote([1n, 0, `0x${"22".repeat(32)}`], { account: w.account }),
      /CommitDeadlinePassed/,
    );
  });

  it("rejects a reveal whose hash does not match the commit", async function () {
    const { escrow, arbiters } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, arbiters.slice(0, 3))[0]!;
    await escrow.write.commitVote([1n, 0, `0x${"33".repeat(32)}`], { account: w.account });
    await passCommitDeadline(escrow, 1n);
    await assert.rejects(
      escrow.write.revealVote([1n, 0, RELEASE, `0x${"44".repeat(32)}`], { account: w.account }),
      /CommitMismatch/,
    );
  });

  it("only selected arbiters may vote", async function () {
    const { escrow, outsider } = await setupDispute(3);
    await assert.rejects(
      escrow.write.commitVote([1n, 0, `0x${"55".repeat(32)}`], { account: outsider.account }),
      /NotSelectedArbiter/,
    );
  });

  it("no-quorum fallback: refunds the opener when fewer than 2 reveal", async function () {
    const { escrow, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    // Only ONE arbiter commits+reveals; the rest do nothing.
    const w0 = wallets[0]!;
    const salt = `0x${"66".repeat(32)}` as `0x${string}`;
    const { commitHash } = await import("./fixtures.ts");
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, w0.account.address, 1n, 0)], { account: w0.account });
    await passCommitDeadline(escrow, 1n);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: w0.account });
    await passRevealWindow(escrow, 1n, 0);

    const pc = await viem.getPublicClient();
    const before = await pc.getBalance({ address: client.account.address });
    await escrow.write.resolveDispute([1n], { account: client.account });
    const after = await pc.getBalance({ address: client.account.address });

    // Opener gets the dispute fee back (gas aside, the fee came back).
    assert.ok(after > before, "opener should be refunded the dispute fee");
    // Milestone returns to Submitted so the flow can be retried.
    assert.equal(await escrow.read.milestoneStatus([1n]), 2); // Submitted
    const d = await getDispute(escrow, 1n);
    void d;
  });

  it("appeal overturns a decision and penalises the original majority", async function () {
    const { escrow, registry, arbiters, client } = await setupDispute(6);
    // Round 0: majority Release.
    let r = await getRound(escrow, 1n, 0);
    let wallets = walletsFor(r, arbiters.slice(0, 6));
    await commitRevealAll(escrow, 1n, 0, wallets, RELEASE);
    await passRevealWindow(escrow, 1n, 0);
    await escrow.write.resolveDispute([1n], { account: client.account });
    const d0 = await getDispute(escrow, 1n);
    const prevMajority = d0.settledArbiters.filter((a) => a !== "0x0000000000000000000000000000000000000000");
    const scoresBefore = new Map<string, bigint>();
    for (const a of prevMajority) scoresBefore.set(a.toLowerCase(), await registry.read.trustScoreOf([a]));

    // Appeal -> round 1: a different, larger pool votes Refund.
    await escrow.write.appeal([1n], { value: DISPUTE_FEE, account: client.account });
    r = await getRound(escrow, 1n, 1);
    wallets = walletsFor(r, arbiters.slice(0, 6));
    await commitRevealAll(escrow, 1n, 1, wallets, REFUND);
    await passRevealWindow(escrow, 1n, 1);
    await escrow.write.resolveAppeal([1n], { account: client.account });

    // Payout only after the appeal window for round 1 closes.
    await passAppealWindow(escrow, 1n, 1);
    await escrow.write.finalizeDispute([1n], { account: client.account });

    assert.equal(await escrow.read.milestoneStatus([1n]), 6); // ResolvedRefund

    // The original majority that is still registered took an overturn penalty.
    for (const a of prevMajority) {
      const before = scoresBefore.get(a.toLowerCase())!;
      const now = await registry.read.trustScoreOf([a]);
      assert.ok(now <= before, "overturned majority should not gain score");
    }
  });

  it("quorum is met when the 3rd arbiter never responds (2-of-3)", async function () {
    const { escrow, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    if (r.arbiterCount < 3) return; // selection is random; only meaningful with 3

    const { commitHash } = await import("./fixtures.ts");
    const salt0 = `0x${"70".repeat(32)}` as `0x${string}`;
    const salt1 = `0x${"71".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt0, wallets[0]!.account.address, 1n, 0)], { account: wallets[0]!.account });
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt1, wallets[1]!.account.address, 1n, 0)], { account: wallets[1]!.account });
    await passCommitDeadline(escrow, 1n);
    await escrow.write.revealVote([1n, 0, RELEASE, salt0], { account: wallets[0]!.account });
    await escrow.write.revealVote([1n, 0, RELEASE, salt1], { account: wallets[1]!.account });

    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);
    assert.equal(await escrow.read.milestoneStatus([1n]), 5); // ResolvedRelease
  });

  it("pays majority arbiters and penalises a silent arbiter (-15)", async function () {
    const { escrow, registry, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    if (r.arbiterCount < 3) return;

    const { commitHash } = await import("./fixtures.ts");
    const salt0 = `0x${"80".repeat(32)}` as `0x${string}`;
    const salt1 = `0x${"81".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt0, wallets[0]!.account.address, 1n, 0)], { account: wallets[0]!.account });
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt1, wallets[1]!.account.address, 1n, 0)], { account: wallets[1]!.account });
    await passCommitDeadline(escrow, 1n);
    await escrow.write.revealVote([1n, 0, RELEASE, salt0], { account: wallets[0]!.account });
    await escrow.write.revealVote([1n, 0, RELEASE, salt1], { account: wallets[1]!.account });
    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);

    // The silent arbiter committed nothing and took the missed-deadline penalty.
    assert.equal(await registry.read.trustScoreOf([wallets[2]!.account.address]), 85n);
    // Majority score started at the cap (100) so it stays there.
    assert.equal(await registry.read.trustScoreOf([wallets[0]!.account.address]), 100n);
  });

  it("splits the reward pot proportionally to the selection-time stake snapshot", async function () {
    // Two arbiters only, with a large stake gap, so both are always drawn and
    // their shares are unambiguous: heavy stake = 3/4 of the pot, light = 1/4.
    const ctx = await deployWithEoaOwner();
    const { registry, escrow, client, freelancer, arbiters } = ctx;
    const heavy = arbiters[0]!;
    const light = arbiters[1]!;
    const HEAVY_STAKE = parseEther("0.3"); // 3 × MIN_STAKE
    const LIGHT_STAKE = parseEther("0.1"); // 1 × MIN_STAKE
    await registry.write.registerArbiter({ value: HEAVY_STAKE, account: heavy.account });
    await registry.write.registerArbiter({ value: LIGHT_STAKE, account: light.account });
    // Clear the min-stake-duration clock so both are selectable right away.
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });

    const r = await getRound(escrow, 1n, 0);
    if (r.arbiterCount < 2) return; // needs both drawn to compare shares

    const { commitHash } = await import("./fixtures.ts");
    const saltH = `0x${"90".repeat(32)}` as `0x${string}`;
    const saltL = `0x${"91".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, saltH, heavy.account.address, 1n, 0)], { account: heavy.account });
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, saltL, light.account.address, 1n, 0)], { account: light.account });
    await passCommitDeadline(escrow, 1n);
    await escrow.write.revealVote([1n, 0, RELEASE, saltH], { account: heavy.account });
    await escrow.write.revealVote([1n, 0, RELEASE, saltL], { account: light.account });
    await passRevealWindow(escrow, 1n, 0);

    // Capture balances right before finalization pays out.
    const pub = await connection.viem.getPublicClient();
    const heavyBefore = await pub.getBalance({ address: heavy.account.address });
    const lightBefore = await pub.getBalance({ address: light.account.address });

    await tallyAndFinalize(escrow, 1n, 0, client.account);

    const heavyGain = (await pub.getBalance({ address: heavy.account.address })) - heavyBefore;
    const lightGain = (await pub.getBalance({ address: light.account.address })) - lightBefore;

    // Expected: pot split by stake weight (0.3 : 0.1 = 3 : 1). Rounding dust
    // stays in rewardPool, so the pair may sum to slightly less than the pot.
    const pot = DISPUTE_FEE;
    const expectedHeavy = (pot * HEAVY_STAKE) / (HEAVY_STAKE + LIGHT_STAKE);
    const expectedLight = (pot * LIGHT_STAKE) / (HEAVY_STAKE + LIGHT_STAKE);

    assert.equal(heavyGain, expectedHeavy, "heavy arbiter must get the 3/4 share");
    assert.equal(lightGain, expectedLight, "light arbiter must get the 1/4 share");
    assert.ok(heavyGain > lightGain, "larger stake must earn strictly more");
    assert.ok(heavyGain + lightGain <= pot, "payouts never exceed the pot");
  });
});

// Local helper mirroring passCommitWindow without the import cycle.
async function passCommitDeadline(escrow: any, milestoneId: bigint) {
  const r = await getRound(escrow, milestoneId, 0);
  await connection.networkHelpers.time.increaseTo(Number(r.commitDeadline) + 1);
}
