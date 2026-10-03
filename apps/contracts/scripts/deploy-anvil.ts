/**
 * Deploy OpenLance to the local anvil devnet (chain 31337) by delegating to the
 * Hardhat deploy script — the same code path used for Base Sepolia, so dev and
 * testnet can never drift.
 *
 * Boot flow (scripts/anvil/dev-real.sh): anvil up -> this script -> .env written
 * -> migrate -> `pnpm dev` starts the API in CHAIN_MODE=real.
 *
 * Output: a single JSON line on stdout:
 *   {"escrow":"0x..","arbiterRegistry":"0x..","roleRegistry":"0x..","timelock":"0x..","sponsorshipForwarder":"0x..","deployer":"0x..","chainId":31337}
 *
 * Implementation: spawns `hardhat run scripts/deploy.ts --network localhost`
 * from this package's directory, parses the printed addresses, and writes the
 * deployment JSON to the repo root (where the other anvil tooling reads it).
 *
 * Lives inside apps/contracts rather than scripts/anvil/ because it is a
 * contracts concern: it needs this package's `viem` and its Hardhat config.
 */
import { spawnSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));
// This file is apps/contracts/scripts/deploy-anvil.ts, so the package root is
// its parent and the repo root is two levels up.
const contractsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");

// Anvil account #0 — the devnet deployer and the default ADMIN_WALLETS entry.
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

async function main() {
  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) throw new Error(`expected chain 31337, got ${chainId}`);

  // Short timelock delay on the devnet so wiring feels immediate.
  const res = spawnSync(
    "pnpm",
    ["exec", "hardhat", "run", "scripts/deploy.ts", "--network", "localhost"],
    {
      cwd: contractsDir,
      env: { ...process.env, TIMELOCK_DELAY: "5", BASE_SEPOLIA_RPC_URL: RPC, DEPLOYER_KEY: process.env.DEPLOYER_KEY ?? "" },
      encoding: "utf8",
    },
  );

  if (res.status !== 0) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`hardhat deploy exited with ${res.status}`);
  }

  const out = res.stdout + res.stderr;
  const grab = (key: string) => {
    const m = out.match(new RegExp(`${key}=(0x[0-9a-fA-F]{40})`));
    if (!m) throw new Error(`could not parse ${key} from deploy output`);
    return m[1];
  };

  const deployment = {
    escrow: grab("ESCROW_ADDRESS"),
    arbiterRegistry: grab("ARBITER_REGISTRY_ADDRESS"),
    // The wallet-owned seat. Missing here means an API that reads a stale/none
    // RoleRegistry, so it is parsed like the others rather than defaulted.
    roleRegistry: grab("ROLE_REGISTRY_ADDRESS"),
    timelock: grab("TIMELOCK_ADDRESS"),
    // Escrow/Registry are initialized with THIS address as their trusted
    // ERC-2771 forwarder, so it has to reach the env: an API pointed at any
    // other forwarder makes every sponsored action revert NotParty().
    sponsorshipForwarder: grab("SPONSORSHIP_FORWARDER_ADDRESS"),
    deployer: DEPLOYER,
    chainId,
  };

  writeFileSync(resolve(repoRoot, "scripts/anvil/.anvil-deployment.json"), JSON.stringify(deployment, null, 2));
  console.log(JSON.stringify(deployment));
}

main().catch((err) => {
  console.error("deploy-anvil failed:", err);
  process.exit(1);
});
