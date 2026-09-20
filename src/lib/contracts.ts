/**
 * Contract surface for wallet transactions (byte-locked to the Hardhat 3
 * contracts by contracts/test/event-surface.ts on the contract side). These
 * addresses are the ERC1967/UUPS proxies owned by the TimelockController.
 */
import type { Abi } from "viem";

export const ESCROW_ABI = [
  { type: "function", name: "fund", stateMutability: "payable", inputs: [{ name: "ref", type: "bytes32" }, { name: "freelancer", type: "address" }], outputs: [] },
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  // Multi-arbiter dispute lifecycle.
  { type: "function", name: "openDispute", stateMutability: "payable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "commitVote", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }, { name: "round", type: "uint8" }, { name: "commitHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "revealVote", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }, { name: "round", type: "uint8" }, { name: "outcome", type: "uint8" }, { name: "salt", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolveDispute", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizeDispute", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "appeal", stateMutability: "payable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "resolveAppeal", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdrawFees", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] },
  { type: "function", name: "accruedFees", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "disputeFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "activeDisputes", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "appealWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "commitWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "revealWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "milestoneStatus", stateMutability: "view", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "getMilestone", stateMutability: "view", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [{ components: [{ name: "client", type: "address" }, { name: "freelancer", type: "address" }, { name: "amount", type: "uint256" }, { name: "feeBps", type: "uint16" }, { name: "status", type: "uint8" }], name: "", type: "tuple" }] },
  {
    type: "function", name: "getRound", stateMutability: "view",
    inputs: [{ name: "milestoneId", type: "uint256" }, { name: "round", type: "uint8" }],
    outputs: [
      { name: "arbiters", type: "address[3]" },
      { name: "arbiterCount", type: "uint8" },
      { name: "commitCount", type: "uint8" },
      { name: "revealCount", type: "uint8" },
      { name: "tally", type: "uint8[3]" },
      { name: "commitDeadline", type: "uint64" },
      { name: "revealDeadline", type: "uint64" },
      { name: "resolved", type: "bool" },
      { name: "winningOutcome", type: "uint8" },
    ],
  },
  {
    type: "function", name: "computeCommit", stateMutability: "pure",
    inputs: [
      { name: "milestoneId", type: "uint256" },
      { name: "round", type: "uint8" },
      { name: "outcome", type: "uint8" },
      { name: "salt", type: "bytes32" },
      { name: "arbiter", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const satisfies Abi;

export const REGISTRY_ABI = [
  { type: "function", name: "register", stateMutability: "payable", inputs: [{ name: "arbiter", type: "address" }], outputs: [] },
  { type: "function", name: "registerArbiter", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "addStake", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "requestUnstake", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "cancelUnstake", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "withdrawStake", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "stakeOf", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "tierOf", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "tierSilver", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "tierGold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "setTierThresholds", stateMutability: "nonpayable", inputs: [{ name: "silverStake", type: "uint256" }, { name: "goldStake", type: "uint256" }], outputs: [] },
  { type: "function", name: "trustScoreOf", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "isEligible", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "isLocked", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "minStake", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "minScoreToWithdraw", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "minStakeDuration", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "unstakeCooldown", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "eligibleAt", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "unstakeReadyAt", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "isRegistered", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "arbiterInfo", stateMutability: "view",
    inputs: [{ name: "arbiter", type: "address" }],
    outputs: [{
      components: [
        { name: "registered", type: "bool" },
        { name: "unstakeRequested", type: "bool" },
        { name: "tokenId", type: "uint256" },
        { name: "trustScore", type: "uint256" },
        { name: "stake", type: "uint256" },
        { name: "resolutions", type: "uint256" },
        { name: "stakedAt", type: "uint256" },
        { name: "unstakeRequestedAt", type: "uint256" },
      ],
      name: "", type: "tuple",
    }],
  },
] as const satisfies Abi;

/** resolveDispute outcome enum (Escrow.sol) */
export const DISPUTE_OUTCOME = { release: 0, refund: 1, split: 2 } as const;
export type DisputeOutcome = keyof typeof DISPUTE_OUTCOME;

/** Escrow.Phase enum ordinals → names (mirrors the contract). */
export const DISPUTE_PHASE = { none: 0, commit: 1, reveal: 2, resolved: 3 } as const;
export type DisputePhaseName = keyof typeof DISPUTE_PHASE;

/** REASON_* codes emitted by ScoreChanged (ArbiterRegistry). */
export const SCORE_REASON = { 1: "majority", 2: "minority", 3: "missed", 4: "overturned", 5: "recovery" } as const;

export const MAX_ARBITERS = 3;
export const QUORUM = 2;
