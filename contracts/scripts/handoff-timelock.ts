/**
 * Hand the timelock to the final admin (a Safe multisig in production).
 *
 * After deploy, the deployer holds PROPOSER/EXECUTOR/CANCELLER and ADMIN roles.
 * Production must move those to a multisig and renounce the deployer's roles —
 * otherwise the "timelock" is a single-key EOA in disguise.
 *
 * This script grants the roles to `FINAL_ADMIN`, then (optionally) renounces the
 * deployer's own roles when `RENOUNCE_DEPLOYER=1`. Role grants are themselves
 * timelock operations and are subject to `minDelay`.
 *
 * Env:
 *   TIMELOCK_ADDRESS  required
 *   FINAL_ADMIN       required — the address to hand control to
 *   RENOUNCE_DEPLOYER optional — "1" to renounce the deployer's roles after grant
 *
 * Usage:
 *   TIMELOCK_ADDRESS=0x.. FINAL_ADMIN=0x.. \
 *     npx hardhat run scripts/handoff-timelock.ts --network baseSepolia
 */
import hardhat, { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

const TIMELOCK_ABI = [
  { type: "function", name: "PROPOSER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "EXECUTOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "CANCELLER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "DEFAULT_ADMIN_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "renounceRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "callerConfirmation", type: "address" }], outputs: [] },
] as const;

async function main() {
  const hre = hardhat as never;
  const connection = await network.create();
  const { viem, networkName } = connection;
  const [deployer] = await viem.getWalletClients();

  const timelockAddress = process.env.TIMELOCK_ADDRESS as `0x${string}` | undefined;
  const finalAdmin = process.env.FINAL_ADMIN as `0x${string}` | undefined;
  const renounce = process.env.RENOUNCE_DEPLOYER === "1";

  if (!timelockAddress || !finalAdmin) {
    throw new Error("TIMELOCK_ADDRESS and FINAL_ADMIN are required");
  }
  if (finalAdmin === deployer.account.address) {
    throw new Error("FINAL_ADMIN equals the deployer — nothing to hand off. Set a Safe address.");
  }

  const timelock = await viem.getContractAt("OpenLanceTimelock", timelockAddress);
  const roles = (await Promise.all([
    timelock.read.PROPOSER_ROLE(),
    timelock.read.EXECUTOR_ROLE(),
    timelock.read.CANCELLER_ROLE(),
    timelock.read.DEFAULT_ADMIN_ROLE(),
  ])) as `0x${string}`[];

  console.log(`Handoff on ${networkName}: ${deployer.account.address} -> ${finalAdmin}\n`);

  for (const role of roles) {
    // Grant the role through the timelock (delay applies).
    const data = encodeFunctionData({
      abi: TIMELOCK_ABI,
      functionName: "grantRole",
      args: [role, finalAdmin],
    });
    await timelock.write.schedule([timelockAddress, 0n, data, zeroHash, zeroHash, 0n], { account: deployer.account });
    console.log(`  scheduled grantRole(${role.slice(0, 10)}…)`);
  }

  console.log(
    `\nAfter the delay elapses, execute each scheduled op (scripts/execute-timelock.ts).\n` +
      `Then, once ${finalAdmin} confirms control, renounce the deployer's roles:\n` +
      `  RENOUNCE_DEPLOYER=1 npx hardhat run scripts/handoff-timelock.ts --network ${networkName}\n`,
  );

  if (renounce) {
    for (const role of roles) {
      const hash = await timelock.write.renounceRole([role, deployer.account.address], { account: deployer.account });
      console.log(`  renounced ${role.slice(0, 10)}… (tx ${hash})`);
    }
    console.log("\n✓ Deployer roles renounced.");
  }
  void hre;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
