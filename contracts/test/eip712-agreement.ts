/**
 * Cross-layer EIP-712 agreement: the digest the CLIENT signs (frontend typed-data
 * shape, as served by /auth/sponsorship and /relay/prepare) must equal the digest
 * the CONTRACT computes. A mismatch here is the #1 integration risk of the
 * gasless feature — this test pins it down for both typed-data payloads.
 *
 * It reconstructs the exact `domain`/`types`/`message` the backend returns
 * (src/server/modules/sponsorship.ts) and checks:
 *   - sponsorshipSessionDigest(owner, issuedAt, expiry, sessionId) == hashTypedData(...)
 *   - forwardRequestDigest(req, sessionId)                        == hashTypedData(...)
 * then runs a full sponsored fund() using a viem wallet client that signs with
 * the frontend domain, proving the whole chain is wire-compatible.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployWithEoaOwner, connection, getMilestone } from "./fixtures.ts";
import { parseEther, getAddress, keccak256, toHex, hashTypedData, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { viem } = connection;
const REF = `0x${"cd".repeat(32)}` as `0x${string}`;

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

describe("EIP-712 agreement (frontend shape ↔ contract)", () => {
  it("session digest matches the frontend typed-data hash", async () => {
    const { forwarder } = await deployWithEoaOwner();
    const owner = privateKeyToAccount(`0x${"77".repeat(32)}`).address;
    const issuedAt = 1_800_000_000n;
    const expiry = 1_800_003_600n;
    const sessionId = keccak256(toHex("demo-session"));

    const domain = {
      name: "OpenLance SponsorshipForwarder",
      version: "1",
      chainId: 31337,
      verifyingContract: forwarder.address,
    } as const;

    const clientDigest = hashTypedData({
      domain,
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner, issuedAt, expiry, sessionId },
    });
    const contractDigest = await forwarder.read.sponsorshipSessionDigest([owner, issuedAt, expiry, sessionId]);
    assert.equal(clientDigest, contractDigest);
  });

  it("forward-request digest matches the frontend typed-data hash", async () => {
    const { escrow, forwarder, freelancer } = await deployWithEoaOwner();
    const from = privateKeyToAccount(`0x${"88".repeat(32)}`).address;
    const data = encodeFunctionData({ abi: FUND_ABI, functionName: "fund", args: [REF, freelancer.account.address] });
    const req = {
      from,
      to: escrow.address,
      value: parseEther("1"),
      gas: 1_000_000n,
      nonce: 0n,
      deadline: 1_800_000_600n,
      data,
    };
    const sessionId = keccak256(toHex("demo-session-2"));

    const domain = {
      name: "OpenLance SponsorshipForwarder",
      version: "1",
      chainId: 31337,
      verifyingContract: forwarder.address,
    } as const;

    const clientDigest = hashTypedData({
      domain,
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId },
    });
    const contractDigest = await forwarder.read.forwardRequestDigest([req, sessionId]);
    assert.equal(clientDigest, contractDigest);
  });

  it("end-to-end: frontend-shaped signatures drive a sponsored fund()", async () => {
    const { escrow, forwarder, deployer, freelancer } = await deployWithEoaOwner();
    const user = privateKeyToAccount(`0x${"99".repeat(32)}`);
    const sid = keccak256(toHex("e2e-session"));
    const pc = await viem.getPublicClient();
    const now = (await pc.getBlock({ blockTag: "latest" })).timestamp;

    const domain = {
      name: "OpenLance SponsorshipForwarder",
      version: "1",
      chainId: 31337,
      verifyingContract: forwarder.address,
    } as const;

    const sessionSig = await user.signTypedData({
      domain,
      types: SESSION_TYPES,
      primaryType: "SponsorshipSession",
      message: { owner: user.address, issuedAt: now, expiry: now + 3_600n, sessionId: sid },
    });
    await forwarder.write.registerSession([user.address, now, now + 3_600n, sid, sessionSig], {
      account: deployer.account,
    });

    const amount = parseEther("3");
    const data = encodeFunctionData({ abi: FUND_ABI, functionName: "fund", args: [REF, freelancer.account.address] });
    const req = { from: user.address, to: escrow.address, value: amount, gas: 1_000_000n, nonce: 0n, deadline: now + 600n, data };
    const reqSig = await user.signTypedData({
      domain,
      types: REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: { ...req, sessionId: sid },
    });

    await forwarder.write.execute([req, sid, reqSig], { account: deployer.account, value: amount });

    const m = await getMilestone(escrow, 1n);
    assert.equal(getAddress(m.client), getAddress(user.address));
    assert.equal(m.amount, amount);
  });
});
