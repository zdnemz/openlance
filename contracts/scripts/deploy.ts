/**
 * Deploy OpenLance behind UUPS proxies, with a TimelockController as the upgrade
 * authority. Works on any network (localhost / baseSepolia / mainnet).
 *
 * Topology
 * ────────
 *   TimelockController ── owns (sole upgrade authority of) ──┐
 *        │ proposer/executor = deployer (hand off in prod)    │
 *        ├── ArbiterRegistry proxy (ERC1967/UUPS)             │
 *        └── Escrow proxy (ERC1967/UUPS) ── reads ──► ArbiterRegistry
 *
 * Why a Timelock: a UUPS upgrade is a `delegatecall` swap of all the money
 * logic. Whoever owns the proxy can drain the escrow. A timelock forces every
 * upgrade (and every owner-only action like setFeeBps) to be publicly visible
 * for `minDelay` before it can execute — users can exit in that window.
 *
 * This script:
 *   1. deploys the TimelockController,
 *   2. deploys both proxies with `initialOwner = timelock`,
 *   3. wires registry.setEscrow(escrow) through the timelock (schedule+execute),
 *   4. by default executes immediately on local networks and *schedules only*
 *      on public networks, printing the exact `execute` command + ETA.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/deploy.ts --network localhost       # anvil
 *   npx hardhat run scripts/deploy.ts --network baseSepolia     # testnet
 *
 * Env:
 *   INITIAL_FEE_BPS   default 250 (2.5%)
 *   FINAL_ADMIN       address that should ultimately own the timelock
 *                     (a Safe multisig in production). Defaults to deployer.
 *   TIMELOCK_DELAY    seconds; default 60 on local, 172800 (48h) elsewhere.
 */
import hardhat, { network } from "hardhat";
import { encodeFunctionData, formatEther, parseEther } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const isLocal = (name: string) => name === "localhost" || name === "hardhat";

async function main() {
  const hre = hardhat as never; // HardhatRuntimeEnvironment
  const connection = await network.create();
  const { viem, networkName } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  if (!deployer?.account) {
    throw new Error("No deployer account configured for this network.");
  }
  const deployerAddress = deployer.account.address;
  const local = isLocal(networkName);

  const minDelay = BigInt(
    process.env.TIMELOCK_DELAY ?? (local ? "60" : "172800"), // 48h
  );
  const feeBps = Number(process.env.INITIAL_FEE_BPS ?? "250");
  const finalAdmin = (process.env.FINAL_ADMIN ?? deployerAddress) as `0x${string}`;

  // ── Multi-arbiter parameters ───────────────────────────────────────────────
  const minStake = BigInt(process.env.MIN_STAKE_WEI ?? (local ? parseEther("0.1") : parseEther("0.1")));
  const minScoreToWithdraw = BigInt(process.env.MIN_SCORE_TO_WITHDRAW ?? "50");
  // Time-based staking rules. Local devnet defaults short so the rules are
  // observable without warping days of chain time; production defaults 7d/3d.
  const minStakeDuration = BigInt(process.env.MIN_STAKE_DURATION_SECONDS ?? (local ? "60" : String(7 * 86400)));
  const unstakeCooldown = BigInt(process.env.UNSTAKE_COOLDOWN_SECONDS ?? (local ? "60" : String(3 * 86400)));
  const treasury = (process.env.TREASURY ?? finalAdmin) as `0x${string}`;
  const disputeFee = BigInt(process.env.DISPUTE_FEE_WEI ?? parseEther("0.05"));
  const commitWindow = BigInt(process.env.COMMIT_WINDOW_SECONDS ?? (local ? "120" : "86400")); // 24h
  const revealWindow = BigInt(process.env.REVEAL_WINDOW_SECONDS ?? (local ? "120" : "86400")); // 24h
  const appealWindow = BigInt(process.env.APPEAL_WINDOW_SECONDS ?? (local ? "600" : "172800")); // 48h

  const chainId = await publicClient.getChainId();
  const balance = await publicClient.getBalance({ address: deployerAddress });

  console.log(`\n── OpenLance deploy ──────────────────────────────────────`);
  console.log(`  network:        ${networkName} (chainId ${chainId})`);
  console.log(`  deployer:       ${deployerAddress}`);
  console.log(`  balance:        ${formatEther(balance)} ETH`);
  console.log(`  timelock delay: ${minDelay}s`);
  console.log(`  fee:            ${feeBps} bps`);
  console.log(`  min stake:      ${formatEther(minStake)} ETH`);
  console.log(`  min score:      ${minScoreToWithdraw}`);
  console.log(`  min stake time: ${minStakeDuration}s`);
  console.log(`  unstake cooldown: ${unstakeCooldown}s`);
  console.log(`  dispute fee:    ${formatEther(disputeFee)} ETH`);
  console.log(`  windows (c/r/a): ${commitWindow}s / ${revealWindow}s / ${appealWindow}s`);
  console.log(`  treasury:       ${treasury}`);
  console.log(`  final admin:    ${finalAdmin}`);
  console.log(`──────────────────────────────────────────────────────────\n`);

  if (balance === 0n && !local) {
    throw new Error(`Deployer ${deployerAddress} has zero balance — fund it first.`);
  }

  // ── 1. TimelockController ─────────────────────────────────────────────────
  const timelock = await viem.deployContract("OpenLanceTimelock", [
    minDelay,
    [deployerAddress], // proposers
    [deployerAddress], // executors
    deployerAddress, // admin (bootstrap; renounce after handoff)
  ]);
  console.log(`✓ OpenLanceTimelock           ${timelock.address}`);

  // ── 2. Sponsorship forwarder (ERC-2771 gasless meta-txs) ──────────────────
  // Not upgradeable on purpose: it holds no funds, only verifies user-signed
  // session vouchers and forwards calls. Replacing it = redeploy + repoint.
  const forwarder = await viem.deployContract("SponsorshipForwarder", []);
  console.log(`✓ SponsorshipForwarder       ${forwarder.address}`);

  // ── 3. Proxies (owner = timelock) ─────────────────────────────────────────
  const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
  const upgradesApi = await upgrades(hre, connection as never);

  const registry = await upgradesApi.deployProxy(
    "ArbiterRegistry",
    [
      "OpenLance Arbiter", // name
      "OLANCE", // symbol
      timelock.address, // owner
      minStake, // minStake
      minScoreToWithdraw, // minScoreToWithdraw
      treasury, // treasury
      minStakeDuration, // minStakeDuration (seconds)
      unstakeCooldown, // unstakeCooldown (seconds)
      forwarder.address, // trustedForwarder (ERC-2771)
    ],
    { kind: "uups" },
  );
  console.log(`✓ ArbiterRegistry proxy       ${registry.address}`);

  const escrow = await upgradesApi.deployProxy(
    "Escrow",
    [
      registry.address, // arbiterRegistry
      timelock.address, // owner
      feeBps, // platform fee
      disputeFee, // minimum dispute fee
      treasury, // treasury
      commitWindow, // commit window
      revealWindow, // reveal window
      appealWindow, // appeal window
      forwarder.address, // trustedForwarder (ERC-2771)
    ],
    { kind: "uups" },
  );
  console.log(`✓ Escrow proxy                ${escrow.address}`);

  // ── 4. Wire registry.setEscrow(escrow) through the timelock ───────────────
  // setEscrow is onlyOwner; owner is the timelock, so it must be scheduled.
  const registryAbi = registry.abi;
  const calldata = encodeFunctionData({
    abi: registryAbi,
    functionName: "setEscrow",
    args: [escrow.address],
  });

  const salt = ("0x" + "00".repeat(32)) as `0x${string}`;
  const predecessor = ("0x" + "00".repeat(32)) as `0x${string}`;

  console.log(`\n→ Scheduling registry.setEscrow(escrow) via timelock…`);
  const scheduleHash = await timelock.write.schedule(
    [registry.address, 0n, calldata, predecessor, salt, minDelay],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: scheduleHash });
  const eta = BigInt(Math.floor(Date.now() / 1000)) + minDelay + 5n;
  console.log(`  scheduled (tx ${scheduleHash}), eta ≈ ${eta}`);

  if (local) {
    // Local networks: we can advance time, but anvil/hardhat may not allow it
    // via viem easily — just wait out a short delay.
    console.log(`  waiting ${minDelay}s for the timelock…`);
    await new Promise((r) => setTimeout(r, Number(minDelay) * 1000 + 2000));
  } else {
    console.log(
      `\n  ⏳ On a public network the 48h delay must elapse before executing.\n` +
        `     After it does, claim the wiring with:\n\n` +
        `     npx hardhat run scripts/execute-timelock.ts --network ${networkName}\n`,
    );
    printSummary({ registry: registry.address, escrow: escrow.address, timelock: timelock.address, forwarder: forwarder.address, finalAdmin, networkName });
    return;
  }

  const execHash = await timelock.write.execute(
    [registry.address, 0n, calldata, predecessor, salt],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: execHash });
  console.log(`✓ registry.setEscrow wired (tx ${execHash})`);

  printSummary({ registry: registry.address, escrow: escrow.address, timelock: timelock.address, forwarder: forwarder.address, finalAdmin, networkName });
}

function printSummary(a: {
  registry: string;
  escrow: string;
  timelock: string;
  forwarder: string;
  finalAdmin: string;
  networkName: string;
}) {
  // Persist the addresses so export-abi.ts and the backend can consume them.
  const depDir = resolve(process.cwd(), "deployments");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    resolve(depDir, `${a.networkName}.json`),
    JSON.stringify(
      {
        network: a.networkName,
        escrow: a.escrow,
        arbiterRegistry: a.registry,
        timelock: a.timelock,
        sponsorshipForwarder: a.forwarder,
        treasury: (process.env.TREASURY ?? a.finalAdmin),
        finalAdmin: a.finalAdmin,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\n✓ wrote deployments/${a.networkName}.json`);

  console.log(`\n══════════════════ Environment (.env) ══════════════════`);
  console.log(`CHAIN_MODE=real`);
  console.log(`CHAIN_ID=${a.networkName === "baseSepolia" ? 84532 : "<chain id>"}`);
  console.log(`ESCROW_ADDRESS=${a.escrow}`);
  console.log(`ARBITER_REGISTRY_ADDRESS=${a.registry}`);
  console.log(`TIMELOCK_ADDRESS=${a.timelock}`);
  console.log(`SPONSORSHIP_FORWARDER_ADDRESS=${a.forwarder}`);
  console.log(`════════════════════════════════════════════════════════\n`);
  console.log(`Next: hand the timelock to the final admin (${a.finalAdmin}) —`);
  console.log(`      grant PROPOSER/EXECUTOR/CANCELLER + ADMIN roles, then renounce`);
  console.log(`      the deployer's roles. See scripts/handoff-timelock.ts.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
