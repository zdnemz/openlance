/**
 * Runtime self-check for the wallet's chain endpoint (run: pnpm check:wallet-rpc).
 *
 * The bug: `chainParams()` handed the wallet `relayRpcUrl()` — the API service —
 * as the network's `rpcUrls`. So the wallet's chain endpoint WAS the API, and
 * the API runs `node --watch`, meaning every source edit restarted the process
 * the wallet depends on. Each restart was an endpoint outage, and the wallet
 * responded with its own circuit breaker: "RPC endpoint returned too many
 * errors, retrying in 0.5 minutes. Consider using a different RPC endpoint."
 * Outside dev it is worse than noisy — the relay targets `ANVIL_RPC_URL`,
 * unset in a deployment, and fails closed with a 502, so accepting the chain
 * prompt installed a permanently dead endpoint.
 *
 * A wallet extension can reach a local node directly; only the PAGE needs the
 * relay, for CORS. So the two are now deliberately different URLs, and this
 * pins that the one registered with the wallet is the node.
 *
 * How this is testable with no chain and no wallet: `window.ethereum` is
 * stubbed, `eth_chainId` reports the wrong chain, and `wallet_switchEthereumChain`
 * rejects 4902 — which is exactly the path that ends in `wallet_addEthereumChain`.
 * The recorded `rpcUrls` is then the thing a real wallet would have stored
 * permanently, so asserting on it is asserting on the defect.
 *
 * Note: `localStorage` is stubbed alongside `window.ethereum` (zustand's
 * `persist` resolves storage at import time), and `NEXT_PUBLIC_API_BASE` is set
 * before the dynamic import because `lib/api.ts` reads it at module scope.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Abi } from "viem";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const API_BASE = "http://api.invalid:12322";
const RELAY = `${API_BASE}/api/rpc`;
const NODE = "http://127.0.0.1:8545";

/* ── the wallet stub ─────────────────────────────────────────────────────── */

type Args = { method: string; params?: unknown[] };
type Params = [Record<string, unknown>?];

/** The rpcUrls a real wallet would have stored, from the last add call. */
let added: string[] = [];
/** What `eth_chainId` reports. Wrong on purpose, unless a test says otherwise. */
let chainId = "0x1";

function stub() {
  added = [];
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    ethereum: {
      request: ({ method, params }: Args) => {
        if (method === "eth_chainId") return Promise.resolve(chainId);
        if (method === "wallet_switchEthereumChain") {
          // 4902 = the wallet has never heard of this chain.
          return Promise.reject({ code: 4902, message: "Unrecognized chain ID" });
        }
        if (method === "wallet_addEthereumChain") {
          const [p] = (params ?? []) as Params;
          added = (p?.rpcUrls as string[]) ?? [];
          return Promise.resolve(null);
        }
        if (method === "wallet_requestPermissions") return Promise.resolve(null);
        if (method === "eth_requestAccounts") return Promise.resolve([WALLET]);
        if (method === "eth_sendTransaction") return Promise.resolve(`0x${"ab".repeat(32)}`);
        return Promise.reject(new Error("unstubbed: " + method));
      },
    },
  };
}

const WALLET = "0x3333333333333333333333333333333333333333";
const ABI: Abi = [
  { type: "function", name: "lockBudget", stateMutability: "payable", inputs: [{ name: "jobRef", type: "bytes32" }], outputs: [] },
];
const JOB_REF = `0x${"11".repeat(32)}`;

async function main() {
  process.env.NEXT_PUBLIC_API_BASE = API_BASE;
  stub();
  const { sendContractCall, useWallet } = await import("../lib/wallet.ts");
  const { useRuntime } = await import("../lib/runtime.ts");
  useWallet.setState({ address: WALLET });

  const send = () =>
    sendContractCall({
      to: "0x1111111111111111111111111111111111111111",
      abi: ABI,
      functionName: "lockBudget",
      args: [JOB_REF],
      value: 1_000n,
      expectedChainId: 31337,
    });

  console.log("\nthe wallet is pointed at the node, not at the API");

  useRuntime.setState({ chainRpcUrl: NODE });
  await send();
  check("the added chain carries the node URL", added[0] === NODE, JSON.stringify(added));
  // The regression itself: the API was the wallet's endpoint, so a --watch
  // restart of it took the wallet offline from the chain.
  check("and never the API relay", !added.some((u) => u.startsWith(API_BASE)), JSON.stringify(added));

  console.log("\na deployment with no public node URL keeps today's behaviour");

  useRuntime.setState({ chainRpcUrl: null });
  await send();
  check("it falls back to the relay rather than breaking", added[0] === RELAY, JSON.stringify(added));

  console.log("\na wallet already on the right chain is left alone");

  useRuntime.setState({ chainRpcUrl: NODE });
  chainId = "0x7a69";
  added = [];
  await send();
  check("no chain is reconfigured on every send", added.length === 0, JSON.stringify(added));

  console.log("\nconnecting carries the same URL");

  chainId = "0x1";
  useRuntime.setState({ chainRpcUrl: NODE });
  await useWallet.getState().connectInjected(31337);
  check("connect registers the node too", added[0] === NODE, JSON.stringify(added));

  console.log("\n/overview may only publish the keyless URL");

  // The safety argument for CHAIN_RPC_PUBLIC_URL being a separate variable:
  // /overview is public and unauthenticated, and CHAIN_RPC_URL is routinely a
  // keyed provider (…/v2/<API_KEY>). Publishing it verbatim leaks the key.
  const overview = read("../api/src/modules/overview.ts");
  check(
    "overview publishes CHAIN_RPC_PUBLIC_URL",
    /chainRpcUrl:\s*env\.CHAIN_RPC_PUBLIC_URL\s*\?\?\s*null/.test(overview),
    "it must read the keyless variable, not the server's own endpoint",
  );
  check(
    "and never CHAIN_RPC_URL",
    !/chainRpcUrl:[^,\n]*CHAIN_RPC_URL\b/.test(overview) && !/chainRpcUrl:[^,\n]*env\.CHAIN_RPC_URL/.test(overview),
    "CHAIN_RPC_URL is the server's endpoint and may carry an API key",
  );
  const cfg = read("../api/src/config.ts");
  check(
    "CHAIN_RPC_PUBLIC_URL is optional and url-validated",
    /CHAIN_RPC_PUBLIC_URL:\s*z\.string\(\)\.url\(\)\.optional\(\)/.test(cfg),
    "an unset value is the documented no-public-endpoint case",
  );

  console.log("\nthe value actually reaches the wallet");

  const store = read("lib/runtime.ts");
  check(
    "the runtime store plumbs it from /overview",
    /chainRpcUrl:\s*cfg\.chainRpcUrl \?\? null/.test(store),
    "a config field nothing reads is the bug in a new coat",
  );
  const wal = read("lib/wallet.ts");
  check(
    "sendContractCall passes it to ensureChain",
    /ensureChain\(opts\.expectedChainId,\s*walletChainRpcUrl\(\)/.test(wal),
    "the fallback path is the old bug if the URL is not threaded through",
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures === 0 ? "all good" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
