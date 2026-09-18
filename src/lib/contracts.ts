/**
 * Contract surface for wallet transactions (byte-locked to the Foundry
 * contracts by test/EventSurface.t.sol on the backend side).
 */
import type { Abi } from "viem";

export const ESCROW_ABI = [
  { type: "function", name: "fund", stateMutability: "payable", inputs: [{ name: "ref", type: "bytes32" }, { name: "freelancer", type: "address" }], outputs: [] },
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "openDispute", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [] },
  { type: "function", name: "nominateArbiter", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }, { name: "candidate", type: "address" }], outputs: [] },
  { type: "function", name: "resolveDispute", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "uint256" }, { name: "outcome", type: "uint8" }], outputs: [] },
  { type: "function", name: "withdrawFees", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] },
  { type: "function", name: "accruedFees", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "milestoneStatus", stateMutability: "view", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "getMilestone", stateMutability: "view", inputs: [{ name: "milestoneId", type: "uint256" }], outputs: [{ components: [{ name: "client", type: "address" }, { name: "freelancer", type: "address" }, { name: "amount", type: "uint256" }, { name: "feeBps", type: "uint16" }, { name: "status", type: "uint8" }], name: "", type: "tuple" }] },
] as const satisfies Abi;

export const REGISTRY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "arbiter", type: "address" }], outputs: [] },
  { type: "function", name: "trustScore", stateMutability: "view", inputs: [{ name: "arbiter", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const satisfies Abi;

/** resolveDispute outcome enum (Escrow.sol) */
export const DISPUTE_OUTCOME = { release: 0, refund: 1, split: 2 } as const;
