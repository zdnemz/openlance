/// <reference types="node" />
/**
 * Export the deployed-contract ABIs + bytecode metadata to a stable path the
 * backend and frontend can import from, so the interface is generated from the
 * compiled contracts rather than hand-maintained.
 *
 *   npx hardhat run scripts/export-abi.ts
 *
 * Writes contracts/exports/<Contract>.json with { abi, bytecode } for each
 * public contract, plus contracts/exports/addresses.json if a deployment file
 * exists.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "exports");
mkdirSync(outDir, { recursive: true });

const CONTRACTS = ["Escrow", "ArbiterRegistry", "IArbiterRegistry", "OpenLanceTimelock", "SponsorshipForwarder"];
const ARTIFACTS: Record<string, string> = {
  Escrow: "artifacts/contracts/Escrow.sol/Escrow.json",
  ArbiterRegistry: "artifacts/contracts/ArbiterRegistry.sol/ArbiterRegistry.json",
  IArbiterRegistry: "artifacts/contracts/IArbiterRegistry.sol/IArbiterRegistry.json",
  OpenLanceTimelock: "artifacts/contracts/OpenLanceTimelock.sol/OpenLanceTimelock.json",
  SponsorshipForwarder: "artifacts/contracts/SponsorshipForwarder.sol/SponsorshipForwarder.json",
};

for (const name of CONTRACTS) {
  const raw = JSON.parse(readFileSync(resolve(root, ARTIFACTS[name]), "utf8"));
  writeFileSync(
    resolve(outDir, `${name}.json`),
    JSON.stringify({ contractName: name, abi: raw.abi, bytecode: raw.bytecode }, null, 2),
  );
  console.log(`✓ exports/${name}.json (${raw.abi.length} ABI entries)`);
}

// Best-effort: copy the latest deployment addresses if present.
try {
  const dep = JSON.parse(readFileSync(resolve(root, "deployments/base-sepolia.json"), "utf8"));
  writeFileSync(resolve(outDir, "addresses.json"), JSON.stringify(dep, null, 2));
  console.log("✓ exports/addresses.json");
} catch {
  console.log("… no deployments/base-sepolia.json yet — skipping addresses export");
}
