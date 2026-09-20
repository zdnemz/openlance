/**
 * Gasless sponsorship (ERC-2771 + EIP-712 session vouchers).
 *
 * Proves the load-bearing properties of the fee-removal feature:
 *   - a signed-up user can fund a milestone with the RELAYER paying gas,
 *     and `client == user` (not the relayer) is recorded on-chain;
 *   - the contract rejects an expired session, a bad request signature, a
 *     replayed nonce, and an unregistered session — so the relayer key alone
 *     cannot move money;
 *   - direct (user-paid) calls still work, unchanged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, getMilestone } from "./fixtures.ts";
import { parseEther, getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { viem, networkHelpers } = connection;
const REF = `0x${"ab".repeat(32)}` as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/** EIP-712 domain for the SponsorshipForwarder (must match the contract). */
const DOMAIN = {
  name: "OpenLance SponsorshipForwarder",
  version: "1",
  chainId: 31337,
} as const;

const SESSION_TYPES = {
  SponsorshipSession: [
    { name: "owner", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "sessionId", type: "bytes32" },
  ],
} as const;

const REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
    { name: "sessionId", type: "bytes32" },
  ],
} as const;


/** Latest block timestamp — tests must anchor on chain time, not wall clock. */
async function chainNow(): Promise<bigint> {
  const pc = await viem.getPublicClient();
  const block = await pc.getBlock({ blockTag: "latest" });
  return block.timestamp;
}

function sessionId(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

describe("SponsorshipForwarder — gasless money actions", () => {
  it("lets a signed-in user fund with the relayer paying gas", async () => {
    const { escrow, registry, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const publicClient = await viem.getPublicClient();

    // A brand-new user key (their wallet signs; the relayer broadcasts).
    const user = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const relayer = deployer; // relayer pays gas
    const sid = sessionId("session-1");

    // 1. Register the login-time sponsorship session voucher.
    const issuedAt = await chainNow();
    const expiry = issuedAt + 3600n;
    const sessionSig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner: user.address, issuedAt, expiry, sessionId: sid },
    });
    await forwarder.write.registerSession([user.address, issuedAt, expiry, sid, sessionSig], {
      account: relayer.account,
    });

    // 2. User signs a ForwardRequest to escrow.fund(ref, freelancer).
    const amount = parseEther("2");
    const fundData = encodeFund(REF, freelancer.account.address);
    const req = {
      from: user.address,
      to: escrow.address,
      value: amount,
      gas: 1_000_000n,
      nonce: 0n,
      deadline: (await chainNow()) + 100_000_000n,
      data: fundData,
    };
    const reqSig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId: sid },
    });

    // 3. Relayer submits; user pays nothing.
    const userBalBefore = await publicClient.getBalance({ address: user.address }); // 0
    await forwarder.write.execute([req, sid, reqSig], { account: relayer.account, value: amount });

    // 4. On-chain truth: the USER is the client, not the relayer.
    const m = await getMilestone(escrow, 1n);
    assert.equal(getAddress(m.client), getAddress(user.address));
    assert.equal(m.amount, amount);
    assert.equal(await escrow.read.milestoneStatus([1n]), 1); // Funded

    // User's balance is unchanged (they were never funded with ETH at all).
    assert.equal(await publicClient.getBalance({ address: user.address }), userBalBefore);

    // Registry/escrow trust the forwarder.
    assert.equal(await escrow.read.isTrustedForwarder([forwarder.address]), true);
    assert.equal(await registry.read.isTrustedForwarder([forwarder.address]), true);
  });

  it("rejects an expired session at registration", async () => {
    const { forwarder, deployer } = await deployWithEoaOwner();
    const user = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const sid = sessionId("expired");
    const now = await chainNow();
    const sig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner: user.address, issuedAt: now - 7200n, expiry: now - 3600n, sessionId: sid },
    });
    await assert.rejects(
      forwarder.write.registerSession([user.address, now - 7200n, now - 3600n, sid, sig], { account: deployer.account }),
      /SessionExpired/,
    );
  });

  it("rejects a request signed by anyone other than `from`", async () => {
    const { escrow, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const user = privateKeyToAccount(`0x${"33".repeat(32)}`);
    const attacker = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const sid = sessionId("bad-sig");

    const now = await chainNow();
    const sessionSig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner: user.address, issuedAt: now, expiry: now + 3600n, sessionId: sid },
    });
    await forwarder.write.registerSession([user.address, now, now + 3600n, sid, sessionSig], { account: deployer.account });

    const req = {
      from: user.address,
      to: escrow.address,
      value: parseEther("1"),
      gas: 1_000_000n,
      nonce: 0n,
      deadline: now + 100_000_000n,
      data: encodeFund(REF, freelancer.account.address),
    };
    // Attacker signs the request, but `from` is the victim → must revert.
    const badSig = await attacker.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId: sid },
    });
    await assert.rejects(
      forwarder.write.execute([req, sid, badSig], { account: deployer.account }),
      /InvalidRequestSignature/,
    );
  });

  it("rejects a replayed request (nonce reuse)", async () => {
    const { escrow, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const user = privateKeyToAccount(`0x${"55".repeat(32)}`);
    const sid = sessionId("replay");
    const now = await chainNow();

    const sessionSig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner: user.address, issuedAt: now, expiry: now + 3600n, sessionId: sid },
    });
    await forwarder.write.registerSession([user.address, now, now + 3600n, sid, sessionSig], { account: deployer.account });

    const req = {
      from: user.address,
      to: escrow.address,
      value: parseEther("1"),
      gas: 1_000_000n,
      nonce: 0n,
      deadline: now + 100_000_000n,
      data: encodeFund(REF, freelancer.account.address),
    };
    const sig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId: sid },
    });

    await forwarder.write.execute([req, sid, sig], { account: deployer.account, value: req.value });
    // Same nonce again → InvalidNonce.
    await assert.rejects(
      forwarder.write.execute([req, sid, sig], { account: deployer.account }),
      /InvalidNonce/,
    );
  });

  it("rejects execution under an unregistered session", async () => {
    const { escrow, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const user = privateKeyToAccount(`0x${"66".repeat(32)}`);
    const sid = sessionId("never-registered");
    const now = await chainNow();
    const req = {
      from: user.address,
      to: escrow.address,
      value: parseEther("1"),
      gas: 1_000_000n,
      nonce: 0n,
      deadline: now + 100_000_000n,
      data: encodeFund(REF, freelancer.account.address),
    };
    const sig = await user.signTypedData({
      domain: { ...DOMAIN, verifyingContract: forwarder.address },
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId: sid },
    });
    await assert.rejects(
      forwarder.write.execute([req, sid, sig], { account: deployer.account }),
      /InvalidSession/,
    );
  });

  it("leaves direct (user-paid) calls working unchanged", async () => {
    const { escrow, deployer, freelancer } = await deployWithEoaOwner();
    await escrow.write.fund([REF, freelancer.account.address], { value: parseEther("1"), account: deployer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 1);
    const m = await getMilestone(escrow, 1n);
    assert.equal(getAddress(m.client), getAddress(deployer.account.address));
  });
});

// ── Minimal ABI encoding for the fund() call (avoids importing the full ABI) ──
import { encodeFunctionData } from "viem";
const FUND_ABI = [
  {
    type: "function",
    name: "fund",
    stateMutability: "payable",
    inputs: [
      { name: "ref", type: "bytes32" },
      { name: "freelancer", type: "address" },
    ],
    outputs: [],
  },
] as const;

function encodeFund(ref: `0x${string}`, freelancer: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: FUND_ABI, functionName: "fund", args: [ref, freelancer] });
}

void ZERO;
void networkHelpers;
