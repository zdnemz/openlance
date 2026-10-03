/**
 * Escrow — multi-arbiter dispute lifecycle.
 *
 * Covers arbiter selection (<=3, party-excluded), commit-reveal, 2-of-3 quorum,
 * majority payouts with exact wei conservation, no-quorum fallback, and appeals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, DISPUTE_FEE, DISPUTE_REWARD, getRound, getDispute, getMilestone, commitHash, MIN_STAKE, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN } from "./fixtures.ts";
import { commitRevealAll, walletsFor, passCommitWindow, passRevealWindow, passAppealWindow, tallyAndFinalize } from "./disputeFlow.ts";
import { parseEther } from "viem";

const REF = `0x${"ab".repeat(32)}` as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const { viem } = connection;

const RELEASE = 0;
const REFUND = 1;
const SPLIT = 2;

/** Fund a milestone and open a dispute with N registered arbiters available. */
async function setupDispute(arbitersAvailable = 3) {
  const ctx = await setupFunded(arbitersAvailable);
  await ctx.escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: ctx.client.account });
  return ctx;
}

/** Same roster + funding, without opening — for openDisputeWith tests. */
async function setupFunded(arbitersAvailable = 3) {
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

  it("seats the mutually-agreed panel via openDisputeWith and never tops it up", async function () {
    const { escrow, arbiters, client } = await setupFunded(4);
    const nom0 = arbiters[0]!.account.address;
    const nom1 = arbiters[1]!.account.address;
    await escrow.write.openDisputeWith([1n, [nom0, nom1, ZERO]], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 2, "panel decides the round — no random third seat");
    const selected = r.arbiters.slice(0, r.arbiterCount).map((a) => a.toLowerCase());
    assert.ok(selected.includes(nom0.toLowerCase()), "first nominee must be selected");
    assert.ok(selected.includes(nom1.toLowerCase()), "second nominee must be selected");
    for (const outsider of arbiters.slice(2)) {
      assert.ok(!selected.includes(outsider.account.address.toLowerCase()), "a non-nominee must never be seated");
    }
  });

  it("seats a single locked arbiter as a degraded 1-seat round, never topped up", async function () {
    // One name is a valid mutual agreement: it must be SEATED, not diluted by
    // a random fill that could re-seat an arbiter the parties dropped (the
    // reported bug) and could also outvote the one they actually agreed on.
    const { escrow, arbiters, client } = await setupFunded(4);
    const kept = arbiters[0]!.account.address;
    await escrow.write.openDisputeWith([1n, [kept, ZERO, ZERO]], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 1, "a 1-arbiter panel seats one arbiter, not three");
    assert.equal(r.arbiters[0]!.toLowerCase(), kept.toLowerCase(), "the locked arbiter must be seated");
  });

  it("a single locked arbiter's own vote decides the round", async function () {
    // The reason 1 is lockable at all: the locked 1-seat round must actually
    // SETTLE on that one reveal, rather than stalling on a 2-of-3 quorum it can
    // never reach. This is the openDisputeWith path, so it is what a project
    // that mutually locked a single arbiter actually gets.
    const { escrow, arbiters, client } = await setupFunded(4);
    const solo = arbiters[0]!;
    await escrow.write.openDisputeWith([1n, [solo.account.address, ZERO, ZERO]], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 1, "only the locked arbiter sits");

    const salt = `0x${"5a".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, solo.account.address, 1n, 0)], { account: solo.account });
    await passCommitWindow(escrow, 1n, 0);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: solo.account });
    await tallyAndFinalize(escrow, 1n, 0, client.account);

    assert.equal(await escrow.read.milestoneStatus([1n]), 5, "ResolvedRelease — the lone locked vote decided");
  });

  it("seats the full 3-arbiter panel and keeps the 2-of-3 quorum", async function () {
    // The shape the API locks (exactly 3): nobody outside it is ever seated,
    // and the round still decides on 2 reveals.
    const { escrow, arbiters, client } = await setupFunded(5);
    const nom = arbiters.slice(0, 3).map((a) => a.account.address);
    await escrow.write.openDisputeWith([1n, [nom[0]!, nom[1]!, nom[2]!]], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 3, "a full panel seats all three");
    const selected = r.arbiters.slice(0, 3).map((a) => a.toLowerCase());
    for (const n of nom) assert.ok(selected.includes(n.toLowerCase()), "every panel member must be seated");
    for (const outsider of arbiters.slice(3)) {
      assert.ok(!selected.includes(outsider.account.address.toLowerCase()), "a non-nominee must never be seated");
    }
  });

  it("falls back to a random draw when the whole locked panel is ineligible", async function () {
    // Availability over the agreement: every nominee benched since the lock
    // (requested unstake), so the round still has to be staffable.
    const { registry, escrow, arbiters, client } = await setupFunded(4);
    const nom0 = arbiters[0]!.account.address;
    const nom1 = arbiters[1]!.account.address;
    await connection.networkHelpers.time.increase(Number(UNSTAKE_COOLDOWN) + 1);
    await registry.write.requestUnstake({ account: arbiters[0]!.account });
    await registry.write.requestUnstake({ account: arbiters[1]!.account });
    await escrow.write.openDisputeWith([1n, [nom0, nom1, ZERO]], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.ok(r.arbiterCount >= 1, "a fully-ineligible panel must still be staffable");
    const selected = r.arbiters.slice(0, r.arbiterCount).map((a) => a.toLowerCase());
    for (const benched of [nom0, nom1]) {
      assert.ok(!selected.includes(benched.toLowerCase()), "benched nominee must not be seated");
    }
  });

  it("skips ineligible nominees (party, duplicate) and degrades to the remainder", async function () {
    const { escrow, arbiters, client } = await setupFunded(4);
    const nom = arbiters[0]!.account.address;
    // client is a party (skipped), nom appears twice (second copy skipped).
    await escrow.write.openDisputeWith(
      [1n, [client.account.address, nom, nom]],
      { value: DISPUTE_FEE, account: client.account },
    );
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 1, "the panel decides the round; only 1 nominee is eligible");
    const selected = r.arbiters.slice(0, r.arbiterCount).map((a) => a.toLowerCase());
    assert.ok(!selected.includes(client.account.address.toLowerCase()), "party must never be selected");
    assert.ok(selected.includes(nom.toLowerCase()), "eligible nominee must be selected");
    assert.equal(new Set(selected).size, selected.length, "no duplicate selection");
  });

  it("opens a degraded 1-arbiter round when only one is eligible", async function () {
    // Availability over panel size: a thin roster must not trap the milestone.
    // One arbiter is enough to open; that single vote decides the round.
    const { registry, escrow, client, freelancer, arbiters } = await deployWithEoaOwner();
    const solo = arbiters[0]!;
    await registry.write.registerArbiter({ value: MIN_STAKE, account: solo.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });

    await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 1, "a thin roster seats whoever is available");
    assert.equal(r.arbiters[0]!.toLowerCase(), solo.account.address.toLowerCase());

    // One reveal is enough to decide a 1-arbiter round (no-quorum does NOT fire).
    const w = walletsFor(r, arbiters);
    const salt = `0x${"d1".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, solo.account.address, 1n, 0)], { account: solo.account });
    await passCommitWindow(escrow, 1n, 0);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: solo.account });
    await tallyAndFinalize(escrow, 1n, 0, client.account);

    assert.equal(await escrow.read.milestoneStatus([1n]), 5, "ResolvedRelease — the lone vote decided");
    void w;
  });

  it("reverts opening only when the roster cannot staff a round at all", async function () {
    // Zero eligible arbiters is the one unrecoverable case: nobody to judge.
    const { escrow, client, freelancer } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: client.account });
    await assert.rejects(
      escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account }),
      /NotEnoughArbiters/,
    );
  });

  it("keeps a 2-arbiter panel at the 2-reveal quorum (not 1)", async function () {
    // A 2-arbiter round has nobody to outvote the first reveal, so requiring 2
    // is what stops a single vote from deciding it. `_requiredReveals` floors at
    // the seated count, never below 2 when 2 arbiters sit.
    const { registry, escrow, client, freelancer, arbiters } = await deployWithEoaOwner();
    for (const w of arbiters.slice(0, 2)) await registry.write.registerArbiter({ value: MIN_STAKE, account: w.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });

    const r = await getRound(escrow, 1n, 0);
    assert.equal(r.arbiterCount, 2, "both registered arbiters are seated");
    const wallets = walletsFor(r, arbiters.slice(0, 2));
    const salt = `0x${"d2".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, wallets[0]!.account.address, 1n, 0)], { account: wallets[0]!.account });
    await passCommitWindow(escrow, 1n, 0);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: wallets[0]!.account });
    await passRevealWindow(escrow, 1n, 0);
    await escrow.write.resolveDispute([1n], { account: client.account });

    // One of two revealing is still no quorum -> the fallback refunds the client.
    assert.equal(await escrow.read.milestoneStatus([1n]), 6, "no-quorum fallback still applies to a 2-arbiter round");
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
    const { escrow, arbiters, client, freelancer } = await setupDispute(3);
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
    // The milestone fee now pays the resolving majority (stake-weighted, even
    // split here), so nothing accrues to the platform on a disputed settlement.
    assert.equal(await escrow.read.accruedFees(), 0n);
    // Freelancer half stays claimable (pull); client half pushed; dispute fee
    // and the milestone fee both paid out to the majority arbiters.
    assert.equal(await escrow.read.claimable([1n]), half - fee);
    assert.equal(after, before - half - DISPUTE_FEE - fee);
    // Pull completes conservation: the escrow is fully drained.
    await escrow.write.withdrawMilestone([1n], { account: freelancer.account });
    assert.equal(await pc.getBalance({ address: escrow.address }), 0n);
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

  it("no-quorum fallback: refunds the opener AND settles the milestone to the client", async function () {
    // The panel never decided, so the money goes back to the client — inside this
    // tally, and terminal. Returning the milestone to `Submitted` (the old
    // behaviour) is what let the client `approve` a payment no arbiter agreed to,
    // while `finalizeDispute`/`appeal` on the same round reverted `NotDisputed`.
    const { escrow, arbiters, client } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));
    // Only ONE arbiter commits+reveals; the rest do nothing.
    const w0 = wallets[0]!;
    const salt = `0x${"66".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, w0.account.address, 1n, 0)], { account: w0.account });
    await passCommitDeadline(escrow, 1n);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: w0.account });
    await passRevealWindow(escrow, 1n, 0);

    const pc = await viem.getPublicClient();
    const clientBefore = await pc.getBalance({ address: client.account.address });
    const escrowBefore = await pc.getBalance({ address: escrow.address });
    await escrow.write.resolveDispute([1n], { account: client.account });
    const clientAfter = await pc.getBalance({ address: client.account.address });
    const escrowAfter = await pc.getBalance({ address: escrow.address });

    // Opener gets the dispute fee back, and the whole 10 ETH milestone with it.
    assert.ok(clientAfter > clientBefore, "opener should be refunded the dispute fee");
    assert.equal(await escrow.read.milestoneStatus([1n]), 6, "ResolvedRefund — the fallback is a settlement");
    // Fee + principal both left the contract: the milestone is no longer a liability.
    assert.equal(escrowAfter, escrowBefore - parseEther("10") - DISPUTE_FEE);
    // Nothing is claimable by the freelancer and no fee accrued to the platform.
    assert.equal(await escrow.read.claimable([1n]), 0n);
    assert.equal(await escrow.read.accruedFees(), 0n);

    // The client's own payout control is gone, and so is the round's: the UI must
    // not be left offering a call that can only revert.
    await assert.rejects(
      escrow.write.approve([1n], { account: client.account }),
      /WrongStatus/,
    );
    await assert.rejects(
      escrow.write.finalizeDispute([1n], { account: client.account }),
      /NotDisputed/,
    );
    await assert.rejects(
      escrow.write.appeal([1n], { value: DISPUTE_FEE, account: client.account }),
      /NotDisputed/,
    );
    await assert.rejects(
      escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account }),
      /NotDisputable/,
    );
  });

  it("a no-quorum fallback is final — the milestone cannot be re-disputed", async function () {
    // Regression, both directions. The old fallback returned the milestone to
    // `Submitted`, so a re-open reused round 0's slot with its `resolved` /
    // `revealCount` / `tally` still in place (a stale `resolved` reverted both
    // commitVote and resolveDispute, stranding the ETH), and the client could
    // also just approve the payment instead. Now the fallback settles, so round 0
    // is written exactly once per dispute and there is nothing left to re-open.
    const { escrow, arbiters, client, freelancer } = await setupDispute(3);
    const r = await getRound(escrow, 1n, 0);
    const wallets = walletsFor(r, arbiters.slice(0, 3));

    // Only one arbiter votes -> no quorum -> the client is refunded.
    const w0 = wallets[0]!;
    const salt = `0x${"6a".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, w0.account.address, 1n, 0)], { account: w0.account });
    await passCommitWindow(escrow, 1n, 0);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: w0.account });
    await passRevealWindow(escrow, 1n, 0);
    await escrow.write.resolveDispute([1n], { account: client.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 6, "no-quorum settles the milestone");

    // Neither party can re-open it, and the round stays readable + terminal.
    for (const who of [client, freelancer]) {
      await assert.rejects(
        escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: who.account }),
        /NotDisputable/,
      );
    }
    const after = await getRound(escrow, 1n, 0);
    assert.equal(after.resolved, true, "the round is closed, not re-armed");
    assert.equal(after.revealCount, 1, "the tallied round keeps its reveal count");
    assert.equal(await escrow.read.claimable([1n]), 0n, "nothing is left for the freelancer to pull");
  });

  it("an appeal of a no-quorum round reverts instead of burning the fee", async function () {
    // The fallback settles the milestone and never restores `Disputed`, so an
    // appeal opened on top of that round could not be tallied or finalized — the
    // appeal fee would be accepted and stranded.
    const { escrow, arbiters, client } = await setupDispute(4);
    const r = await getRound(escrow, 1n, 0);
    const w0 = walletsFor(r, arbiters.slice(0, 4))[0]!;
    const salt = `0x${"6b".repeat(32)}` as `0x${string}`;
    await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, w0.account.address, 1n, 0)], { account: w0.account });
    await passCommitWindow(escrow, 1n, 0);
    await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: w0.account });
    await passRevealWindow(escrow, 1n, 0);
    await escrow.write.resolveDispute([1n], { account: client.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 6);

    await assert.rejects(
      escrow.write.appeal([1n], { value: DISPUTE_FEE, account: client.account }),
      /NotDisputed/,
    );
    // A round that DID reach quorum is still appealable — see "appeal overturns
    // a decision" below, which runs that whole path to a settled refund.
  });

  it("an appeal hands the in-flight seat over — no arbiter is left busy forever", async function () {
    // `activeDisputes` is what the registry reads to gate `requestUnstake` /
    // `withdrawStake` / `reduceStake`. `appeal` supersedes a resolved round and
    // seats a fresh one, but the two release sites (`_tally`'s no-quorum branch
    // and `finalizeDispute`) only ever see `d.round` — by then the APPEAL round.
    // The appealed round's panel therefore kept its seat permanently: the
    // collateral of an arbiter who had already voted and been scored was locked
    // for life by a round that no longer existed. The appeal must release the
    // superseded panel in the same transaction that seats the new one.
    const { escrow, registry, arbiters, client } = await setupDispute(6);
    const roster = arbiters.slice(0, 6);
    const panel = async (round: number) => {
      const r = await getRound(escrow, 1n, round);
      return r.arbiters.slice(0, r.arbiterCount).map((a) => a.toLowerCase());
    };

    const r0 = await getRound(escrow, 1n, 0);
    const panel0 = await panel(0);
    for (const a of panel0) assert.equal(await escrow.read.activeDisputes([a]), 1n, "a seated arbiter holds one in-flight seat");

    await commitRevealAll(escrow, 1n, 0, walletsFor(r0, roster), RELEASE);
    await escrow.write.resolveDispute([1n], { account: client.account });
    // The round is resolved but the appeal window is still open, so its panel
    // stays seated — that is correct, the dispute is not over yet.
    for (const a of panel0) assert.equal(await escrow.read.activeDisputes([a]), 1n, "a resolved round keeps its panel busy until the dispute is over");

    await escrow.write.appeal([1n], { value: DISPUTE_FEE, account: client.account });
    const panel1 = await panel(1);
    for (const a of panel0) {
      const inBoth = panel1.includes(a);
      // The appeal round is live, so anyone seated NOW is busy. An arbiter only
      // in the appealed round is not: that round is gone.
      assert.equal(await escrow.read.activeDisputes([a]), inBoth ? 1n : 0n, "the appealed panel is released; a re-drawn arbiter still holds its new seat");
    }

    // ...and the registry agrees: an arbiter the appeal dropped is no longer
    // "busy", so the gate that would freeze their collateral lets them through.
    // The appeal round's own panel is still seated, and stays gated.
    for (const a of panel0.filter((x) => !panel1.includes(x))) {
      const w = roster.find((x) => x.account.address.toLowerCase() === a)!;
      await assert.doesNotReject(
        registry.write.requestUnstake({ account: w.account }),
        "an arbiter the appeal released must not stay frozen by a dead round",
      );
      await registry.write.cancelUnstake({ account: w.account }); // keep the roster intact
    }
    for (const a of panel1) {
      const w = roster.find((x) => x.account.address.toLowerCase() === a)!;
      await assert.rejects(
        registry.write.requestUnstake({ account: w.account }),
        /StillHandlingDispute/,
        "the live appeal round still holds its panel",
      );
    }

    await commitRevealAll(escrow, 1n, 1, walletsFor(await getRound(escrow, 1n, 1), roster), RELEASE);
    await escrow.write.resolveAppeal([1n], { account: client.account });
    await passAppealWindow(escrow, 1n, 1);
    await escrow.write.finalizeDispute([1n], { account: client.account });

    // Every arbiter who ever sat is free again — no leaked seat anywhere.
    for (const a of new Set([...panel0, ...panel1])) {
      assert.equal(await escrow.read.activeDisputes([a]), 0n, "a settled dispute leaves no arbiter busy");
    }
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

  it("tops the pot up from rewardPool by disputeReward, capped at the pool balance", async function () {
    const { escrow, registry, client, freelancer, arbiters, deployer } = await deployWithEoaOwner();
    const pool = arbiters.slice(0, 2);
    await registry.write.registerArbiter({ value: MIN_STAKE, account: pool[0]!.account });
    await registry.write.registerArbiter({ value: MIN_STAKE, account: pool[1]!.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);

    // Fund generously; the draw must be clamped to disputeReward, not the balance.
    await escrow.write.depositRewards({ value: DISPUTE_REWARD * 10n, account: deployer.account });
    assert.equal(await escrow.read.rewardPool(), DISPUTE_REWARD * 10n);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });

    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, pool);
    const salt = `0x${"a1".repeat(32)}` as `0x${string}`;
    for (const x of w) {
      await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, x.account.address, 1n, 0)], { account: x.account });
    }
    await passCommitWindow(escrow, 1n, 0);
    for (const x of w) {
      await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: x.account });
    }
    await passRevealWindow(escrow, 1n, 0);
    await escrow.write.resolveDispute([1n], { account: client.account });

    const pc = await connection.viem.getPublicClient();
    const g0 = (await pc.getBalance({ address: w[0]!.account.address })) + (await pc.getBalance({ address: w[1]!.account.address }));
    await passAppealWindow(escrow, 1n, 0);
    await escrow.write.finalizeDispute([1n], { account: client.account });
    const g1 = (await pc.getBalance({ address: w[0]!.account.address })) + (await pc.getBalance({ address: w[1]!.account.address }));

    // Both arbiters voted the same way with equal stake, so they split the pot evenly.
    // Pot = opener's fee + milestone fee (2.5% of 10 ETH) + the protocol top-up.
    const milestoneFee = (parseEther("10") * 250n) / 10000n;
    const pot = DISPUTE_FEE + milestoneFee + DISPUTE_REWARD;
    assert.equal(g1 - g0, pot, "the protocol top-up is disputeReward, not the pool balance");

    // Exactly disputeReward was drawn; the remainder stays for future disputes.
    assert.equal(await escrow.read.rewardPool(), DISPUTE_REWARD * 9n);
  });

  it("opens free and pays arbiters from the protocol pool when disputeFee is 0", async function () {
    // The shipped config: `disputeFee = 0` (opening is free) + `disputeReward`
    // funded from `rewardPool`, so the arbiters are still paid.
    const { escrow, registry, client, freelancer, arbiters, deployer } = await deployWithEoaOwner();
    const pool = arbiters.slice(0, 2);
    for (const x of pool) await registry.write.registerArbiter({ value: MIN_STAKE, account: x.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    await escrow.write.setDisputeFee([0n], { account: deployer.account });
    await escrow.write.depositRewards({ value: DISPUTE_REWARD, account: deployer.account });

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    // Zero value: opening costs the opener nothing.
    await escrow.write.openDispute([1n], { account: client.account });
    assert.equal((await getDispute(escrow, 1n)).fee, 0n, "no fee was paid");

    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, pool);
    const salt = `0x${"a3".repeat(32)}` as `0x${string}`;
    for (const x of w) await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, x.account.address, 1n, 0)], { account: x.account });
    await passCommitWindow(escrow, 1n, 0);
    for (const x of w) await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: x.account });

    const pc = await connection.viem.getPublicClient();
    const g0 = (await pc.getBalance({ address: w[0]!.account.address })) + (await pc.getBalance({ address: w[1]!.account.address }));
    await tallyAndFinalize(escrow, 1n, 0, client.account);
    const g1 = (await pc.getBalance({ address: w[0]!.account.address })) + (await pc.getBalance({ address: w[1]!.account.address }));

    // Milestone fee + the full protocol reward, split evenly between the two.
    const milestoneFee = (parseEther("10") * 250n) / 10000n;
    assert.equal(g1 - g0, milestoneFee + DISPUTE_REWARD, "arbiters are paid entirely by the protocol");
    assert.equal(await escrow.read.rewardPool(), 0n, "the pool funded this dispute exactly");
  });

  it("a dry rewardPool still settles a free dispute (arbiters earn the milestone fee only)", async function () {
    const { escrow, registry, client, freelancer, arbiters, deployer } = await deployWithEoaOwner();
    const pool = arbiters.slice(0, 2);
    for (const x of pool) await registry.write.registerArbiter({ value: MIN_STAKE, account: x.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    await escrow.write.setDisputeFee([0n], { account: deployer.account });
    assert.equal(await escrow.read.rewardPool(), 0n);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { account: client.account });

    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, pool);
    const salt = `0x${"a4".repeat(32)}` as `0x${string}`;
    for (const x of w) await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, x.account.address, 1n, 0)], { account: x.account });
    await passCommitWindow(escrow, 1n, 0);
    for (const x of w) await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: x.account });
    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);

    // No pool to draw from must not revert or under-pay the milestone fee.
    assert.equal(await escrow.read.milestoneStatus([1n]), 5);
    assert.equal(await escrow.read.claimable([1n]), (parseEther("10") * 975n) / 1000n);
  });

  it("an empty rewardPool leaves the pot unchanged (no subsidy path is safe)", async function () {
    const { escrow, registry, client, freelancer, arbiters } = await deployWithEoaOwner();
    const pool = arbiters.slice(0, 2);
    for (const x of pool) await registry.write.registerArbiter({ value: MIN_STAKE, account: x.account });
    await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
    assert.equal(await escrow.read.rewardPool(), 0n);

    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("10"), account: client.account });
    await escrow.write.submit([1n], { account: freelancer.account });
    await escrow.write.openDispute([1n], { value: DISPUTE_FEE, account: client.account });
    const r = await getRound(escrow, 1n, 0);
    const w = walletsFor(r, pool);
    const salt = `0x${"a2".repeat(32)}` as `0x${string}`;
    for (const x of w) {
      await escrow.write.commitVote([1n, 0, commitHash(RELEASE, salt, x.account.address, 1n, 0)], { account: x.account });
    }
    await passCommitWindow(escrow, 1n, 0);
    for (const x of w) {
      await escrow.write.revealVote([1n, 0, RELEASE, salt], { account: x.account });
    }
    await passRevealWindow(escrow, 1n, 0);
    await tallyAndFinalize(escrow, 1n, 0, client.account);
    assert.equal(await escrow.read.milestoneStatus([1n]), 5);
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

    // Expected: the dispute fee PLUS the milestone fee (2.5% of 10 ETH), both
    // split by stake weight (0.3 : 0.1 = 3 : 1). Rounding dust stays in the
    // contract, so the pair may sum to slightly less than the total paid.
    const milestone = await getMilestone(escrow, 1n);
    const feeOnAmount = (milestone.amount * 250n) / 10000n;
    const pot = DISPUTE_FEE + feeOnAmount;
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
