/**
 * Live end-to-end proof that a published job can be re-published after its
 * budget is withdrawn — the bug report's exact sequence, on the dev chain.
 *
 *   lockBudget  → the publish
 *   unlockBudget→ the client takes the deposit back  (the job goes to draft)
 *   lockBudget  → the re-publish that used to revert
 *
 * Scratch jobRef: it is bytes32 of a value no job row can produce, so it touches
 * no real escrow accounting.
 */
import hardhat from "hardhat";
import { encodeFunctionData, keccak256, stringToHex, parseEther } from "viem";

const c = await hardhat.network.create();
const publicClient = await c.viem.getPublicClient();
const [client] = await c.viem.getWalletClients();

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
if (!ESCROW) throw new Error("ESCROW_ADDRESS required");

const abi = [
  { type: "function", name: "lockBudget", stateMutability: "payable", inputs: [{ name: "jobRef", type: "bytes32" }], outputs: [] },
  { type: "function", name: "unlockBudget", stateMutability: "nonpayable", inputs: [{ name: "jobRef", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "lockedBudget", stateMutability: "view", inputs: [{ name: "jobRef", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paidOutBudget", stateMutability: "view", inputs: [{ name: "jobRef", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

const JOB_REF = keccak256(stringToHex(`scratch-relock-proof-${Date.now()}`));
const BUDGET = parseEther("1");

const send = async (fn: "lockBudget" | "unlockBudget", args: readonly unknown[], value = 0n) => {
  const hash = await client.writeContract({ address: ESCROW, abi, functionName: fn, args: args as never, value });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted (tx ${hash})`);
  return hash;
};
const read = (fn: "lockedBudget" | "paidOutBudget") =>
  publicClient.readContract({ address: ESCROW, abi, functionName: fn, args: [JOB_REF] });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra: unknown = "") => {
  if (ok) { pass++; console.log(`✓ ${name}`); } else { fail++; console.error(`✗ ${name}`, extra); }
};

await send("lockBudget", [JOB_REF], BUDGET);
check("publish locks the ceiling", (await read("lockedBudget")) === BUDGET);

await send("unlockBudget", [JOB_REF, BUDGET]);
check("withdrawing it empties the lock", (await read("paidOutBudget")) === BUDGET);

// The step that used to revert with BudgetAlreadyLocked.
try {
  await send("lockBudget", [JOB_REF], BUDGET);
  check("re-publish after a full withdrawal succeeds", true);
} catch (err) {
  check("re-publish after a full withdrawal succeeds", false, String(err));
}
check("the re-lock starts a clean balance sheet", (await read("paidOutBudget")) === 0n);
check("and the ceiling is locked again", (await read("lockedBudget")) === BUDGET);

console.log(fail ? `\n${fail} check(s) failed` : `\nAll ${pass} live checks passed`);
process.exitCode = fail ? 1 : 0;
