import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";
import { defineConfig, configVariable } from "hardhat/config";

/**
 * Hardhat 3 config — OpenLance contracts.
 *
 * Networks:
 *   - `hardhat`  (edr-simulated, in-process, for tests)
 *   - `localhost` (anvil / hardhat node on :8545, the devnet)
 *   - `baseSepolia` (chain 84532) — the testnet deployment target
 *
 * Secrets come from `configVariable(...)` so a *name* is stored in config and the
 * *value* is read from env/keystore at runtime. `keystore` is accepted as a
 * fallback so CI and the Hardhat keystore both work.
 */
export default defineConfig({
  plugins: [hardhatToolboxViem, hardhatVerify, hardhatUpgrades],

  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // Base Sepolia is on the Shanghai/Cancun EVM; cancun is safe and enables
          // transient storage (used by OZ's transient ReentrancyGuard if selected).
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 800 },
          evmVersion: "cancun",
        },
      },
    },
  },

  networks: {
    // In-process simulated network used by the test runner.
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },

    // Local devnet (anvil or `hardhat node`). Account #0 of the deterministic set.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      accounts: [
        // anvil deterministic account #0 (public test key, never holds real value)
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ],
    },

    // Base Sepolia testnet.
    baseSepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_KEY")],
      chainId: 84532,
    },

    // In-process fork of Base Sepolia — used to dry-run the deploy against real
    // network state without broadcasting (no funds spent).
    baseSepoliaFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 84532,
      forking: {
        url: configVariable("BASE_SEPOLIA_RPC_URL"),
      },
    },
  },

  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },

  test: {
    solidity: {
      // Keep fuzz/invariant work meaningful without being slow locally.
      fuzz: { runs: 256 },
      invariant: { runs: 128, depth: 128, failOnRevert: false },
    },
  },
});
