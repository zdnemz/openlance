/**
 * Regressions for the 2026-10-03 audit. Each test is a former proof of an
 * attack, inverted: it now asserts the attack fails.
 *
 * Production deploys with disputeFee = 0 (deploy.ts), so `base()` sets it to 0
 * unless a test needs the fee path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connection, deployWithEoaOwner, getRound, MIN_STAKE, MIN_STAKE_DURATION, ZERO32 } from "./fixtures.ts";
import { commit, commitRevealAll, passAppealWindow, passCommitWindow, passRevealWindow, reveal, walletsFor } from "./disputeFlow.ts";

const { viem, networkHelpers } = connection;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const RELEASE = 0, REFUND = 1;
const S = { Disputed: 3, ResolvedRelease: 5, ResolvedRefund: 6 } as const;
const ref = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const lower = (a: string) => a.toLowerCase();

async function base(nArbiters: number, { freeDisputes = true } = {}) {
  const ctx = await deployWithEoaOwner();
  if (freeDisputes) await ctx.escrow.write.setDisputeFee([0n], { account: ctx.deployer.account });
  const roster = ctx.arbiters.slice(0, nArbiters);
  for (const w of roster) await ctx.registry.write.registerArbiter({ value: MIN_STAKE, account: w.account });
  await networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
  return { ...ctx, roster, pc: await viem.getPublicClient() };
}

async function fundAndSubmit(ctx: Awaited<ReturnType<typeof base>>, amount = parseEther("10")) {
  await ctx.escrow.write.fund([ref(1), ctx.freelancer.account.address], { value: amount, account: ctx.client.account });
  await ctx.escrow.write.submit([1n], { account: ctx.freelancer.account });
}

const panelOf = async (escrow: any, id: bigint, round: number) => {
  const r = await getRound(escrow, id, round);
  return r.arbiters.slice(0, r.arbiterCount).map(lower);
};

describe("Audit regressions — Escrow / ArbiterRegistry / Forwarder", () => {
  it("every contract stays deployable under EIP-170", async () => {
    const { readFileSync } = await import("node:fs");
    for (const name of ["Escrow", "ArbiterRegistry", "RoleRegistry", "SponsorshipForwarder"]) {
      const art = JSON.parse(readFileSync(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url), "utf8"));
      const bytes = (art.deployedBytecode.length - 2) / 2;
      assert.ok(bytes <= 24_576, `${name} is ${bytes} bytes — over the 24,576-byte limit`);
    }
  });

  it("C1: a party cannot seat a panel the counterparty did not agree to", async () => {
    const ctx = await base(4);
    await fundAndSubmit(ctx);
    const mine = ctx.roster[3]!.account.address;
    await assert.rejects(
      ctx.escrow.write.openDisputeWith([1n, [mine, ZERO, ZERO]], { account: ctx.client.account }),
      /PanelNotAgreed/,
    );
  });

  it("C1: a silent arbiter pays the missed-reveal penalty on a no-quorum refund", async () => {
    const ctx = await base(1);
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.client.account });
    const silent = (await panelOf(ctx.escrow, 1n, 0))[0]!;
    await passRevealWindow(ctx.escrow, 1n, 0);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.client.account });
    assert.equal(await ctx.escrow.read.milestoneStatus([1n]), S.ResolvedRefund);
    assert.equal(await ctx.registry.read.trustScoreOf([silent]), 85n, "silence is no longer free");
  });

  it("C2: a 1-wei dispute draws no subsidy from the reward pool", async () => {
    const ctx = await base(1);
    await ctx.escrow.write.depositRewards({ value: parseEther("0.15"), account: ctx.deployer.account });
    await ctx.escrow.write.fund([ref(7), ctx.freelancer.account.address], { value: 1n, account: ctx.client.account });
    await ctx.escrow.write.openDispute([1n], { account: ctx.client.account });
    const judge = walletsFor(await getRound(ctx.escrow, 1n, 0), ctx.roster);
    const salt = await commit(ctx.escrow, judge[0]!, 1n, 0, RELEASE, 1);
    await passCommitWindow(ctx.escrow, 1n, 0);
    await reveal(ctx.escrow, judge[0]!, 1n, 0, RELEASE, salt);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.client.account });
    await passAppealWindow(ctx.escrow, 1n, 0);
    await ctx.escrow.write.finalizeDispute([1n], { account: ctx.client.account });
    assert.equal(await ctx.escrow.read.rewardPool(), parseEther("0.15"), "the pool is untouched");
  });

  it("H1: a silent appeal panel leaves the standing ruling in place", async () => {
    const ctx = await base(6);
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.freelancer.account });
    await commitRevealAll(ctx.escrow, 1n, 0, walletsFor(await getRound(ctx.escrow, 1n, 0), ctx.roster), RELEASE);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account });
    await ctx.escrow.write.appeal([1n], { account: ctx.client.account });
    await passRevealWindow(ctx.escrow, 1n, 1);
    await ctx.escrow.write.resolveAppeal([1n], { account: ctx.client.account });
    assert.equal(await ctx.escrow.read.milestoneStatus([1n]), S.Disputed, "no refund");
    await passAppealWindow(ctx.escrow, 1n, 1);
    await ctx.escrow.write.finalizeDispute([1n], { account: ctx.freelancer.account });
    assert.equal(await ctx.escrow.read.milestoneStatus([1n]), S.ResolvedRelease, "the Release ruling is what pays");
  });

  it("H2: appeals stop at MAX_APPEALS", async () => {
    const ctx = await base(6);
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.freelancer.account });
    const max = Number(await ctx.escrow.read.MAX_APPEALS());
    for (let round = 0; round <= max; round++) {
      await commitRevealAll(ctx.escrow, 1n, round, walletsFor(await getRound(ctx.escrow, 1n, round), ctx.roster), RELEASE);
      if (round === 0) await ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account });
      else await ctx.escrow.write.resolveAppeal([1n], { account: ctx.freelancer.account });
      if (round < max) await ctx.escrow.write.appeal([1n], { account: ctx.client.account });
    }
    await assert.rejects(ctx.escrow.write.appeal([1n], { account: ctx.client.account }), /AppealLimitReached/);
  });

  it("H3: an arbiter that rejects ETH is credited instead of freezing the settlement", async () => {
    const ctx = await base(3);
    await ctx.escrow.write.depositRewards({ value: parseEther("1"), account: ctx.deployer.account });
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.freelancer.account });
    const r0 = await getRound(ctx.escrow, 1n, 0);
    await commitRevealAll(ctx.escrow, 1n, 0, walletsFor(r0, ctx.roster), RELEASE);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account });
    await passAppealWindow(ctx.escrow, 1n, 0);
    const stuck = r0.arbiters[0]!;
    await networkHelpers.setCode(stuck, "0x60006000fd");
    await ctx.escrow.write.finalizeDispute([1n], { account: ctx.freelancer.account });
    assert.equal(await ctx.escrow.read.milestoneStatus([1n]), S.ResolvedRelease, "settled");
    assert.ok((await ctx.escrow.read.credit([stuck])) > 0n, "its share waits in credit");
    assert.equal(await ctx.escrow.read.totalCredit(), await ctx.escrow.read.credit([stuck]));
    await networkHelpers.setCode(stuck, "0x"); // the EDR connection is shared across files
    await ctx.escrow.write.withdrawCredit({ account: ctx.roster.find((w) => lower(w.account.address) === lower(stuck))!.account });
    assert.equal(await ctx.escrow.read.totalCredit(), 0n);
  });

  it("M1: resolveDispute cannot tally an appeal round", async () => {
    const ctx = await base(6);
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.freelancer.account });
    await commitRevealAll(ctx.escrow, 1n, 0, walletsFor(await getRound(ctx.escrow, 1n, 0), ctx.roster), RELEASE);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account });
    await ctx.escrow.write.appeal([1n], { account: ctx.client.account });
    await commitRevealAll(ctx.escrow, 1n, 1, walletsFor(await getRound(ctx.escrow, 1n, 1), ctx.roster), REFUND);
    await assert.rejects(ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account }), /AppealAlreadyOpen/);
  });

  it("M3: with 4 eligible arbiters every round seats 3", async () => {
    const ctx = await base(4);
    for (let i = 1; i <= 12; i++) {
      await ctx.escrow.write.fund([ref(i), ctx.freelancer.account.address], { value: 1000n, account: ctx.client.account });
      await ctx.escrow.write.openDispute([BigInt(i)], { account: ctx.client.account });
      assert.equal((await getRound(ctx.escrow, BigInt(i), 0)).arbiterCount, 3, `dispute ${i}`);
    }
  });

  it("M4: every round's fee stays in the pot — nothing is misrouted or stranded", async () => {
    const ctx = await base(6, { freeDisputes: false });
    const fee = await ctx.escrow.read.disputeFee();
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { value: fee, account: ctx.freelancer.account });
    await commitRevealAll(ctx.escrow, 1n, 0, walletsFor(await getRound(ctx.escrow, 1n, 0), ctx.roster), RELEASE);
    await ctx.escrow.write.resolveDispute([1n], { account: ctx.freelancer.account });
    await ctx.escrow.write.appeal([1n], { value: fee, account: ctx.client.account });
    assert.equal((await ctx.escrow.read.getDispute([1n]) as { fee: bigint }).fee, fee * 2n);
    await commitRevealAll(ctx.escrow, 1n, 1, walletsFor(await getRound(ctx.escrow, 1n, 1), ctx.roster), RELEASE);
    await ctx.escrow.write.resolveAppeal([1n], { account: ctx.client.account });
    await passAppealWindow(ctx.escrow, 1n, 1);
    await ctx.escrow.write.finalizeDispute([1n], { account: ctx.freelancer.account });
    await ctx.escrow.write.withdrawMilestone([1n], { account: ctx.freelancer.account });
    const tracked = (await ctx.escrow.read.rewardPool()) + (await ctx.escrow.read.accruedFees()) + (await ctx.escrow.read.totalCredit());
    assert.equal(await ctx.pc.getBalance({ address: ctx.escrow.address }), tracked, "every wei is accounted for");
  });

  it("M5: the arbiter badge cannot be transferred", async () => {
    const ctx = await base(1);
    const a = ctx.roster[0]!;
    const { tokenId } = (await ctx.registry.read.arbiterInfo([a.account.address])) as { tokenId: bigint };
    await assert.rejects(
      ctx.registry.write.transferFrom([a.account.address, ctx.arbiters[12]!.account.address, tokenId], { account: a.account }),
      /NonTransferable/,
    );
    assert.equal(getAddress(await ctx.registry.read.ownerOf([tokenId])), getAddress(a.account.address));
  });

  it("M6: a session only authorizes its own owner, and only until it expires", async () => {
    const { escrow, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const domain = { name: "OpenLance SponsorshipForwarder", version: "1", chainId: 31337, verifyingContract: forwarder.address } as const;
    const alice = privateKeyToAccount(`0x${"31".repeat(32)}`);
    const bob = privateKeyToAccount(`0x${"32".repeat(32)}`);
    const sid = keccak256(toHex("alice-session"));
    const now = (await (await viem.getPublicClient()).getBlock()).timestamp;
    const expiry = now + 600n;
    const sessionSig = await alice.signTypedData({
      domain, primaryType: "SponsorshipSession",
      types: { SponsorshipSession: [{ name: "owner", type: "address" }, { name: "issuedAt", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "sessionId", type: "bytes32" }] },
      message: { owner: alice.address, issuedAt: now, expiry, sessionId: sid },
    });
    await forwarder.write.registerSession([alice.address, now, expiry, sid, sessionSig], { account: deployer.account });

    const types = { ForwardRequest: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "gas", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "data", type: "bytes" }, { name: "sessionId", type: "bytes32" }] } as const;
    const send = async (who: typeof alice, n: number) => {
      const req = {
        from: who.address, to: escrow.address, value: 1n, gas: 500_000n, nonce: 0n, deadline: now + 100_000n,
        data: encodeFunctionData({ abi: escrow.abi, functionName: "fund", args: [ref(n), freelancer.account.address] }),
      };
      const sig = await who.signTypedData({ domain, types, primaryType: "ForwardRequest", message: { ...req, sessionId: sid } });
      return forwarder.write.execute([req, sid, sig], { account: deployer.account, value: 1n });
    };
    await assert.rejects(send(bob, 2), /InvalidSession/, "Bob cannot ride Alice's session");
    await networkHelpers.time.increase(3600);
    await assert.rejects(send(alice, 1), /SessionExpired/, "an expired session is refused on-chain");
  });

  it("M7: a timelock grant must be scheduled with the real min delay", async () => {
    const [deployer] = await viem.getWalletClients();
    const tl = await viem.deployContract("OpenLanceTimelock", [60n, [deployer!.account.address], [deployer!.account.address], deployer!.account.address]);
    const data = encodeFunctionData({ abi: tl.abi, functionName: "grantRole", args: [await tl.read.PROPOSER_ROLE(), deployer!.account.address] });
    await assert.rejects(tl.write.schedule([tl.address, 0n, data, ZERO32, ZERO32, 0n]), /TimelockInsufficientDelay/);
    // what scripts/handoff-timelock.ts now does:
    await tl.write.schedule([tl.address, 0n, data, ZERO32, ZERO32, await tl.read.getMinDelay()]);
  });

  it("L2: an empty commit is refused", async () => {
    const ctx = await base(3);
    await fundAndSubmit(ctx);
    await ctx.escrow.write.openDispute([1n], { account: ctx.client.account });
    const judge = walletsFor(await getRound(ctx.escrow, 1n, 0), ctx.roster)[0]!;
    await assert.rejects(ctx.escrow.write.commitVote([1n, 0, ZERO32], { account: judge.account }), /EmptyCommit/);
  });
});
