/**
 * Upgrade the Escrow UUPS proxy to the current build, on a devnet.
 *
 * WHY THIS EXISTS: `lockBudget` learned to accept a re-lock of a fully spent key
 * (a client who withdraws a published job's budget gets the job back as a draft
 * and must be able to publish again — `bytes32(jobRef)` can never be rotated).
 * That logic lives in the implementation behind the proxy, so editing the source
 * is not enough: the dev chain kept running the previous implementation, and every
 * re-publish reverted with `BudgetAlreadyLocked` with no way for a user to tell
 * why. The receipt only carries a status, so the failure looked like a plain
 * "reverted on-chain".
 *
 * PUBLIC NETWORKS ARE NOT THE TARGET. Production upgrades are scheduled, wait out
 * the 48h delay and executed deliberately; that is `execute-timelock.ts` with an
 * explicit TARGET/CALLDATA. This script is the devnet path: it schedules and
 * immediately executes, and it REFUSES a non-devnet chain id so a stray
 * `pnpm --filter contracts exec hardhat run` can never fast-forward a public
 * timelock.
 *
 *   pnpm --filter @openlance/contracts exec hardhat run scripts/upgrade-escrow.ts --network localhost
 */
import hardhat, { network } from "hardhat";
import { encodeFunctionData, keccak256, stringToHex } from "viem";

const DEV_CHAIN_ID = 31337;

/** `upgradeToAndCall(address,bytes)` — the UUPS entry point, nothing else. */
const escrowUpgradeAbi = [
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "nextMilestoneId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * OZ `TimelockController` (5.6.x) — the real signatures, no more guessing.
 * `schedule` takes a trailing `uint256 delay`; `execute` does not. Getting that
 * asymmetry wrong encodes the wrong selector, the call falls through to the
 * payable `receive()`, and it reverts with EMPTY revert data — which is exactly
 * what an empty `data: 0x` from eth_call means.
 */
const timelockAbi = [
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const connection = await network.create();
  const { viem, networkName } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  if (chainId !== DEV_CHAIN_ID) {
    throw new Error(
      `refusing to upgrade on chain ${chainId}: this script is the devnet path only. ` +
      `Schedule the upgrade and run scripts/execute-timelock.ts for a public network.`,
    );
  }

  const escrowAddress = process.env.ESCROW_ADDRESS as `0x${string}` | undefined;
  const timelockAddress = process.env.TIMELOCK_ADDRESS as `0x${string}` | undefined;
  if (!escrowAddress || !timelockAddress) {
    throw new Error("ESCROW_ADDRESS and TIMELOCK_ADDRESS are required (see scripts/anvil/.anvil-deployment.json)");
  }

  const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
  const upgradesApi = await upgrades(hardhat as never, connection as never);
  const implementation = await upgradesApi.deployImplementation("Escrow", { account: deployer.account });
  console.log(`New Escrow implementation: ${implementation}`);

  // `upgradeToAndCall(address,bytes)` — encoded here rather than through
  // `getContractAt`, which in Hardhat 3 exposes neither encodeFunctionData nor a
  // reliable ABI (its timelock entry reported 5 params where the call takes 6).
  const calldata = encodeFunctionData({
    abi: escrowUpgradeAbi,
    functionName: "upgradeToAndCall",
    args: [implementation, "0x"],
  });

  // The proxy is timelocked, so the swap is a scheduled operation — even here.
  // The salt is derived from the implementation address, NOT a constant: a fixed
  // salt makes the script single-use, because a schedule that mined but whose
  // execute never did leaves the id taken and every re-run reverts
  // `TimelockControllerUnexpectedOperationState`. Each deploy is a fresh address,
  // so each attempt gets a fresh id and the script stays re-runnable.
  const salt = keccak256(stringToHex(`escrow-upgrade:${implementation.toLowerCase()}`));
  const predecessor = `0x${"00".repeat(32)}` as const;

  // Read the delay off the chain and schedule with it, rather than a constant
  // that goes stale the moment the timelock's config changes.
  const minDelay = await publicClient.readContract({
    address: timelockAddress, abi: timelockAbi, functionName: "getMinDelay",
  });

  // Hardhat 3's wallet client can write but not read; the public client is the
  // reverse. Each call goes to the one that has it.
  const write = async (fn: "schedule" | "execute", args: readonly unknown[]) => {
    const hash = await deployer.writeContract({
      address: timelockAddress,
      abi: timelockAbi,
      functionName: fn,
      args: args as never,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`timelock ${fn} reverted (tx ${hash})`);
    return hash;
  };

  console.log(`✓ scheduled (tx ${await write("schedule", [escrowAddress, 0n, calldata, predecessor, salt, minDelay])})`);
  await new Promise((r) => setTimeout(r, (Number(minDelay) + 1) * 1000));
  console.log(`✓ Escrow proxy upgraded (tx ${await write("execute", [escrowAddress, 0n, calldata, predecessor, salt])}) on ${networkName}`);
  // Proof it took: read state THROUGH the proxy, not off the implementation.
  const nextId = await publicClient.readContract({
    address: escrowAddress, abi: escrowUpgradeAbi, functionName: "nextMilestoneId",
  });
  console.log(`  nextMilestoneId through the proxy: ${nextId}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
