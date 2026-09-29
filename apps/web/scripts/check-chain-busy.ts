/**
 * Self-check for the shared chain-busy gate (run: pnpm check:chain-busy).
 *
 * "Every button disables while loading" was true of the wiring and false of
 * the state: `useChainAction` kept `phase` in `useState`, so each CALL SITE got
 * its own copy. A page renders one card per row (the disputes list) and one
 * panel per milestone, so clicking Tally on card A left card B's Tally /
 * Finalize / Appeal buttons live — and a second signature could go out while
 * the first was still mining. Every button read the right flag; it just wasn't
 * the same flag.
 *
 * Two things have to hold, and only the first is a pure function:
 *
 *   1. `isBusy` is the single definition of "a button is dead", and it must
 *      treat "done" as NOT busy. Nothing resets the phase on its own once a tx
 *      lands, so counting "done" as busy strands the room until a reload.
 *      Pinned here by driving the exported rule, not a copy of it.
 *   2. The phase is one app-wide store rather than per-instance state, and
 *      `run` refuses a re-entrant call against that store. This is a hook
 *      lifecycle, so it is pinned by the source assertions below: the hook must
 *      not reintroduce local `useState` for the phase, and no call site may
 *      re-derive its own busy flag and drift from the rule.
 *
 * A real render test (two panels mounted, one firing, the other asserting its
 * buttons go dead) is NOT here: it needs a DOM. `renderToStaticMarkup` cannot
 * stand in — under SSR a zustand selector returns the store's initial snapshot,
 * so the hook reads `escrow: null` and `run()` bails at "Contract address
 * unknown" before ever touching the wallet. Proving the double-submit refusal
 * at runtime means a real client render, i.e. a new test dependency.
 *
 * No network, no chain, no React.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isBusy, type Phase } from "../lib/chain-actions.ts";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

console.log("\nbusy phases (what a button reads)");

// "done" is the load-bearing case: the tx landed and the action is over.
check("an idle wallet is not busy", !isBusy("idle"));
check("waiting for a signature is busy", isBusy("signing"));
check("waiting for the receipt is busy", isBusy("mining"));
check("waiting for the indexer is busy", isBusy("indexing"));
check(
  "a landed tx is NOT busy (nothing resets the phase on its own)",
  !isBusy("done"),
  "counting 'done' as busy locks the room until a reload",
);

// Every phase is accounted for, so a new one cannot be added as a silent
// escape hatch: it has to be declared busy (or deliberately not) here.
const ALL: Phase[] = ["idle", "signing", "mining", "indexing", "done"];
check("the busy set is exactly the three in-flight phases", ALL.filter(isBusy).length === 3, `got ${ALL.filter(isBusy).join(", ")}`);

console.log("\nshared state (one flag, not one per call site)");

const chain = read("lib/chain-actions.ts");

check(
  "the phase lives in a store, not per-hook useState",
  /const useChainTx = create<ChainTxState>/.test(chain) && !/const \[phase, setPhase\] = useState/.test(chain),
  "per-instance phase is the bug this replaced",
);
check(
  "the hook's phase is read FROM the store, so all panels share it",
  /const phase = useChainTx\(\(s\) => s\.phase\)/.test(chain),
  "a locally-held phase is per-call-site — the original bug",
);
check(
  "the error stays LOCAL — a shared one prints one panel's revert under another's buttons",
  /const \[error, setError\] = useState<string \| null>\(null\)/.test(chain) && !/s\.error/.test(chain),
  "error must belong to the action that failed, not to the wallet",
);
check(
  "run() re-reads the store so two panels see each other",
  /isBusy\(useChainTx\.getState\(\)\.phase\)/.test(chain),
  "a closure-captured phase cannot see another panel's write",
);
check(
  "the hook hands call sites the same `active` it gates run() on",
  /active: isBusy\(phase\)/.test(chain),
);

// No call site may re-derive the flag. This is the drift that made one panel
// read `phase !== "idle"` and lock itself shut after a landed tx.
const SITES = [
  "app/(app)/disputes/page.tsx",
  "app/(app)/projects/[id]/page.tsx",
  "app/(app)/admin/page.tsx",
  "components/arbiter-stake-panel.tsx",
];
for (const rel of SITES) {
  check(
    `${rel} reads the shared active, never its own`,
    !/chain\.phase !== "idle"/.test(read(rel)),
    "re-derived busy flag — will drift from isBusy",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures === 0 ? "all good" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
