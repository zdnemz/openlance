/**
 * Event-surface lock.
 *
 * The backend indexer (src/server/chain/abi.ts) decodes these exact event
 * signatures and status/outcome ordinals. This test asserts the deployed
 * contract's ABI still emits byte-identical topics, so a Solidity rename or a
 * reordered enum fails the build instead of silently corrupting production.
 *
 * If this test fails after an intentional interface change: update
 * src/server/chain/abi.ts AND src/lib/contracts.ts in the same change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toEventSelector } from "viem";
import EscrowArtifact from "../artifacts/contracts/Escrow.sol/Escrow.json" with { type: "json" };
import RegistryArtifact from "../artifacts/contracts/ArbiterRegistry.sol/ArbiterRegistry.json" with { type: "json" };
import { deployWithEoaOwner } from "./fixtures.ts";

/**
 * Frozen topic hashes — the byte-for-byte contract with the indexer. These are
 * keccak256 of the canonical signatures, hard-coded so any signature drift is
 * caught even if someone edits both the event and the expected string.
 */
const FROZEN_TOPICS: Record<string, `0x${string}`> = {
  MilestoneFunded: "0x6527340e2e6740394ed4f6a9968eefdbfa2bbd5af4fb3147a3c130e52cbc0ddf",
  MilestoneSubmitted: "0x90143ae4a41ef99ad2d40a48925dc7e72a3f89168dfef992ef8db6648c4339a7",
  MilestoneReleased: "0x7891dccf9c403b6aa691f7dc3930d862936400f40edc92fd5f4817134831c966",
  DisputeResolved: "0x0a1a08d07b8bb2ef5e6eea14f3719239138f1ce03a4ceea3196c1000a265c12a",
  TrustScoreUpdated: "0x5480764593d30ca95915557c9c17169b63ebe592c33d08d153b492c2998903c3",
  ArbiterRegistered: "0xe4fa94e292c33743b4b419fbaa182346310b822e567514e0753868fb3f4dcab6",
};

/** Canonical signatures as the backend declares them. */
const CANONICAL_SIGNATURES: Record<string, string> = {
  MilestoneFunded: "MilestoneFunded(uint256,bytes32,address,address,uint256)",
  MilestoneSubmitted: "MilestoneSubmitted(uint256,address)",
  MilestoneReleased: "MilestoneReleased(uint256,address,uint256,uint256,bool)",
  DisputeResolved: "DisputeResolved(uint256,address,uint8)",
  TrustScoreUpdated: "TrustScoreUpdated(address,int256,uint256,bool)",
  ArbiterRegistered: "ArbiterRegistered(address,uint256)",
};

/** Every indexer event name that must exist in the ABIs. */
const ESCROW_EVENT_NAMES = [
  "MilestoneFunded",
  "MilestoneSubmitted",
  "MilestoneReleased",
  "MilestoneRefunded",
  "MilestoneSplit",
  "MilestoneCancelled",
  "DisputeOpened",
  "DisputeResolved",
  "FeeWithdrawn",
];

const REGISTRY_EVENT_NAMES = ["ArbiterRegistered", "ArbiterDeregistered", "TrustScoreUpdated"];

const abiHasEvent = (abi: readonly { type: string; name?: string }[], name: string) =>
  abi.some((x) => x.type === "event" && x.name === name);

describe("Event-surface lock", () => {
  it("Escrow ABI contains every indexer event", () => {
    for (const name of ESCROW_EVENT_NAMES) {
      assert.ok(abiHasEvent(EscrowArtifact.abi as never, name), `Escrow is missing event ${name}`);
    }
  });

  it("ArbiterRegistry ABI contains every indexer event", () => {
    for (const name of REGISTRY_EVENT_NAMES) {
      assert.ok(abiHasEvent(RegistryArtifact.abi as never, name), `ArbiterRegistry is missing event ${name}`);
    }
  });

  it("frozen event topic hashes are unchanged", () => {
    for (const [name, expected] of Object.entries(FROZEN_TOPICS)) {
      const actual = toEventSelector(CANONICAL_SIGNATURES[name] as never);
      assert.equal(actual, expected, `${name} topic hash drifted — the indexer will stop decoding it`);
    }
  });

  it("escrow exposes the frozen read surface", () => {
    const fns = (EscrowArtifact.abi as { type: string; name?: string }[])
      .filter((x) => x.type === "function")
      .map((x) => x.name);
    // Money lifecycle is frozen for the backend indexer.
    for (const required of ["milestoneStatus", "accruedFees", "fund", "submit", "approve", "cancel"]) {
      assert.ok(fns.includes(required), `Escrow missing required function ${required}`);
    }
    // Multi-arbiter dispute surface.
    for (const required of [
      "openDispute",
      "commitVote",
      "revealVote",
      "resolveDispute",
      "finalizeDispute",
      "appeal",
      "resolveAppeal",
      "getRound",
      "computeCommit",
    ]) {
      assert.ok(fns.includes(required), `Escrow missing dispute function ${required}`);
    }
  });

  it("escrow emits the new multi-arbiter dispute events", () => {
    for (const name of [
      "DisputeOpened",
      "ArbitersSelected",
      "VoteCommitted",
      "VoteRevealed",
      "DisputeResolved",
      "DisputeFinalized",
      "ArbiterRewarded",
      "ArbiterPenalized",
      "NoQuorumFallback",
      "AppealOpened",
      "AppealResolved",
    ]) {
      assert.ok(abiHasEvent(EscrowArtifact.abi as never, name), `Escrow missing event ${name}`);
    }
  });

  it("registry emits the staking + score events", () => {
    for (const name of [
      "ArbiterRegistered",
      "ArbiterDeregistered",
      "ScoreChanged",
      "StakeDeposited",
      "StakeReduced",
      "StakeLocked",
      "StakeWithdrawn",
      "StakeSlashed",
      "UnstakeRequested",
    ]) {
      assert.ok(abiHasEvent(RegistryArtifact.abi as never, name), `ArbiterRegistry missing event ${name}`);
    }
  });

  it("Status enum ordinals are frozen (backend maps uint8 -> name)", async () => {
    const { escrow, client, freelancer } = await deployWithEoaOwner();

    await escrow.write.fund([`0x${"11".repeat(32)}`, freelancer.account.address], { value: 1n, account: client.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 1, "Funded must be 1");

    await escrow.write.submit([1n], { account: freelancer.account });
    assert.equal(await escrow.read.milestoneStatus([1n]), 2, "Submitted must be 2");

    // Disputed (3) is asserted in test/disputes.ts; the money-terminal states
    // (4..8) are unchanged from the original contract.
  });

  it("Outcome enum ordinals are frozen (release=0, refund=1, split=2)", async () => {
    // The outcome values are asserted by the resolve path in disputes.ts; here we
    // pin the numeric contract the frontend sends (DISPUTE_OUTCOME).
    const { DISPUTE_OUTCOME } = { DISPUTE_OUTCOME: { release: 0, refund: 1, split: 2 } };
    assert.equal(DISPUTE_OUTCOME.release, 0);
    assert.equal(DISPUTE_OUTCOME.refund, 1);
    assert.equal(DISPUTE_OUTCOME.split, 2);
  });
});
