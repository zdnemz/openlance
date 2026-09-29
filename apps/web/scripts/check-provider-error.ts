/**
 * Runtime self-check for the provider error boundary (run: pnpm check:provider-error).
 *
 * The bug: an EIP-1193 provider rejection is NOT an `Error`. It is a plain
 * object with `code`/`message` — which is why `ensureChain` already had to
 * reach for `err as { code?: number }` instead of `instanceof`. Every `catch`
 * in the app still read failures the other way round, `err instanceof Error ?
 * err.message : "Unknown error"`, so a wallet that refused a signature showed
 * the poster `Could not publish / Unknown error` — the one failure they most
 * needed named, described as nothing.
 *
 * The fix normalises at `providerRequest`, the single door every wallet call
 * goes through, instead of repeating a guard in the twenty-odd toasts that
 * render one. `lib/wallet.ts` is the responsible layer; a fix at each call
 * site would be a bigger diff that could still drift.
 *
 * What is testable with no wallet and no chain: `sendContractCall` and
 * `ensureChain` are stubbed at `window.ethereum`, and the stub REJECTS the way
 * a real wallet does — with a plain object, with a bare string, with a real
 * `Error`. `sendContractCall` is the exact call the job page's publish button
 * makes, so this is the reported path, not a stand-in.
 *
 * The assertions are `instanceof Error` and `.message`: the toast's own
 * expression is `err instanceof Error ? err.message : "Unknown error"`, so
 * those two properties are exactly what decides what the user reads. Asserting
 * them is asserting the symptom is gone.
 *
 * Note: `localStorage` is stubbed alongside `window.ethereum` — zustand's
 * `persist` (the wallet store) resolves storage at import time, and installing
 * `window` without it takes the harness down before `main` runs. The wallet
 * module is imported DYNAMICALLY, after the stub exists, for the same reason.
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

/* ── the wallet stub ─────────────────────────────────────────────────────── */

type Args = { method: string; params?: unknown[] };
const calls: string[] = [];
let handler: (args: Args) => unknown = () => Promise.reject(new Error("unstubbed provider method"));

(globalThis as unknown as { window: unknown }).window = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  ethereum: {
    request: (args: Args) => {
      calls.push(args.method);
      return handler(args);
    },
  },
};

/** Point the stub at a new behaviour and clear the call log. */
function stub(fn: (args: Args) => unknown) {
  handler = fn;
  calls.length = 0;
}

const ADDR = "0x1111111111111111111111111111111111111111";
const JOB_REF = `0x${"11".repeat(32)}`;
const HASH = `0x${"ab".repeat(32)}`;
const DECLINED = "MetaMask Tx Signature: User denied transaction signature.";

/** viem only needs the signature to encode; the ABI never reaches a chain here. */
const ABI: Abi = [
  { type: "function", name: "lockBudget", stateMutability: "payable", inputs: [{ name: "jobRef", type: "bytes32" }], outputs: [] },
];

/** The value a `catch` receives, or null when the call resolved. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

/** Exactly what the publish button does: lock the budget, then fail. */
function publish() {
  return rejection(
    import("../lib/wallet.ts").then(({ sendContractCall }) =>
      sendContractCall({ to: ADDR, abi: ABI, functionName: "lockBudget", args: [JOB_REF], value: 1_000n }),
    ),
  );
}

const okOnSend = (send: () => unknown) =>
  stub(({ method }) => (method === "eth_sendTransaction" ? send() : Promise.resolve(HASH)));

async function main() {
  const { ensureChain, useWallet } = await import("../lib/wallet.ts");
  useWallet.setState({ address: ADDR });

  console.log("\nthe reported symptom: a declined publish is not an unknown error");

  okOnSend(() => Promise.reject({ code: 4001, message: DECLINED }));
  const declined = (await publish()) as { message?: string; code?: number };
  check("the rejection is an Error", declined instanceof Error, typeof declined);
  check("it carries the wallet's own words", declined?.message === DECLINED, String(declined?.message));
  check("so the toast's own expression cannot print \"Unknown error\"", declined?.message !== "Unknown error");
  // chain-actions.ts decides a decline is not a failure by matching this string.
  // Blind to plain objects it toasts "Chain action failed" on every refusal.
  check("chain-actions' decline detector now recognises it", /reject|denied/i.test(declined?.message ?? ""));
  check("and the 4001 code survives the wrap", declined?.code === 4001, String(declined?.code));

  console.log("\nthe other shapes a wallet rejects with");

  okOnSend(() => Promise.reject("user closed the popup"));
  const bare = (await publish()) as { message?: string };
  check("a bare string is still an Error with text", bare instanceof Error && bare.message === "user closed the popup", String(bare?.message));

  okOnSend(() => Promise.reject({ code: -32000, reason: "insufficient funds for gas" }));
  const reason = (await publish()) as { message?: string };
  check("a `reason` is read when there is no `message`", reason?.message === "insufficient funds for gas", String(reason?.message));

  okOnSend(() => Promise.reject({ code: -32000 }));
  const nameless = (await publish()) as { message?: string };
  check("a nameless rejection still names the method", nameless?.message === "eth_sendTransaction failed", String(nameless?.message));

  const original = new TypeError("boom");
  okOnSend(() => Promise.reject(original));
  check("a real Error passes through untouched (not re-wrapped)", (await publish()) === original);

  console.log("\nthe 4902 branch survives the wrap");

  // Losing `code` here would strand a user on a chain their wallet has never
  // heard of: ensureChain could no longer tell "add it" from "declined".
  stub(({ method }) => {
    if (method === "eth_chainId") return Promise.resolve("0x1");
    if (method === "wallet_switchEthereumChain") return Promise.reject({ code: 4902, message: "Unrecognized chain ID" });
    if (method === "wallet_addEthereumChain") return Promise.resolve(null);
    return Promise.reject(new Error("unstubbed: " + method));
  });
  await rejection(ensureChain(31337));
  check("an unknown chain still reaches wallet_addEthereumChain", calls.includes("wallet_addEthereumChain"), calls.join(", "));

  stub(({ method }) => {
    if (method === "eth_chainId") return Promise.resolve("0x1");
    if (method === "wallet_switchEthereumChain") return Promise.reject({ code: 4001, message: "User rejected the request." });
    return Promise.reject(new Error("unstubbed: " + method));
  });
  const declinedSwitch = await rejection(ensureChain(31337));
  check("a declined chain switch is an Error too", declinedSwitch instanceof Error, typeof declinedSwitch);

  console.log("\none door, so no call site can bypass it");

  const wallet = read("lib/wallet.ts");
  check(
    "window.ethereum.request is called from exactly one place",
    (wallet.match(/ethereum!?\.request\(/g) ?? []).length === 1,
    `${(wallet.match(/ethereum!?\.request\(/g) ?? []).length} call sites — a new one must go through providerRequest`,
  );
  check(
    "and that one place normalises before rethrowing",
    /async function providerRequest[\s\S]*?try \{[\s\S]*?window\.ethereum!\.request\([\s\S]*?throw providerError\(/.test(wallet),
    "the wrapper must wrap, not just forward",
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures === 0 ? "all good" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
