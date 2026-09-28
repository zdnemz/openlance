/**
 * Execute a previously-scheduled timelock operation.
 *
 * The deploy script schedules `registry.setEscrow(escrow)` and, on public
 * networks, exits before execution so the 48h delay can elapse. Run this once
 * the ETA has passed to claim the wiring.
 *
 * Env:
 *   TIMELOCK_ADDRESS  required
 *   TARGET            required — the contract the operation calls
 *   CALLDATA          required — 0x-encoded calldata
 *   PREDECESSOR       optional — default zero
 *   SALT              optional — default zero (must match the schedule)
 *
 * Usage:
 *   TIMELOCK_ADDRESS=0x.. TARGET=0x.. CALLDATA=0x.. \
 *     npx hardhat run scripts/execute-timelock.ts --network baseSepolia
 */
import hardhat, { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { viem, networkName } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const timelockAddress = process.env.TIMELOCK_ADDRESS as `0x${string}` | undefined;
  const target = process.env.TARGET as `0x${string}` | undefined;
  const callData = process.env.CALLDATA as `0x${string}` | undefined;
  const predecessor = (process.env.PREDECESSOR ?? `0x${"00".repeat(32)}`) as `0x${string}`;
  const salt = (process.env.SALT ?? `0x${"00".repeat(32)}`) as `0x${string}`;

  if (!timelockAddress || !target || !callData) {
    throw new Error("TIMELOCK_ADDRESS, TARGET and CALLDATA are required");
  }

  console.log(`Executing timelock op on ${networkName}…`);
  const timelock = await viem.getContractAt("OpenLanceTimelock", timelockAddress);

  const hash = await timelock.write.execute([target, 0n, callData, predecessor, salt], {
    account: deployer.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ executed (status ${receipt.status}, tx ${hash})`);
  void hardhat;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
