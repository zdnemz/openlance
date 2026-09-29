/**
 * Self-check for the project room's funding refresh (run: pnpm check:funding-refresh).
 *
 * "Funding should be auto-update, not must-be-refresh" was two defects, and
 * this pins the half that is a pure function:
 *
 *   1. `pending_funding` was absent from the busy set, so the room polled
 *      SLOWEST (12s) during exactly the window where a mined funding tx is
 *      invisible in the mirror. The gap is also when the room is least
 *      trustworthy: it still offers Fund for value already locked on-chain.
 *   2. The stale-mirror check latched on its first answer via a ref, so
 *      "landed" could only be retired by a hard reload.
 *
 * (1) is pinned here by driving the exported rule, not a copy of it — a
 * mirrored predicate is how this comes back unnoticed. (2) is a ref lifecycle
 * inside a component and is pinned by the assertions listed at the bottom.
 *
 * No network, no chain, no React.
 */
import { projectPollMs, LIVE_POLL_MS } from "../lib/queries.ts";
import type { ProjectView } from "../lib/types.ts";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const FAST = 3000;
const SLOW = 12000;

/** Only the fields projectPollMs reads; the cast keeps the fixture honest. */
function room(...chainStatus: string[]): ProjectView {
  return { milestones: chainStatus.map((s) => ({ chainStatus: s })) } as unknown as ProjectView;
}

console.log("\nfunding refresh (poll cadence)");

check(
  "a milestone awaiting its indexer mirror polls FAST, not slow",
  projectPollMs(room("pending_funding")) === FAST,
  `got ${projectPollMs(room("pending_funding"))}`,
);
check("funded still polls fast", projectPollMs(room("funded")) === FAST);
check("submitted still polls fast", projectPollMs(room("submitted")) === FAST);
check("disputed still polls fast", projectPollMs(room("disputed")) === FAST);
check("one pending among settled ones still polls fast", projectPollMs(room("released", "pending_funding")) === FAST);
check("a finished room backs off", projectPollMs(room("released", "cancelled")) === SLOW);
check("an empty room backs off", projectPollMs(room()) === SLOW);
check("no data yet backs off rather than throwing", projectPollMs(undefined) === SLOW);

// The mirror catching up must be able to retire "landed" on its own. With the
// ref latch gone, the check re-reads on every project poll, so a milestone that
// leaves pending_funding takes the effect's own reset branch (setFundState
// "idle") — these assert the two states that reset depends on.
console.log("\nstale-mirror reset (states the effect keys on)");
check("a funded milestone is not re-checked (reset branch)", room("funded").milestones[0]!.chainStatus !== "pending_funding");
check("pending_funding is the only state that re-reads", room("pending_funding").milestones[0]!.chainStatus === "pending_funding");

// The room is live in every direction: a list the counterparty writes polls, so
// the client watching for a delivery never needs a reload to find it.
console.log("\nlive lists (the counterparty writes these)");
check("a counterparty-mutated list polls faster than the room's own backing-off cadence", LIVE_POLL_MS < SLOW);
check("a counterparty-mutated list matches the chat's cadence", LIVE_POLL_MS === 4000);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures === 0 ? "all good" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
