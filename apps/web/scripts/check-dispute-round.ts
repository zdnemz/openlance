/**
 * Self-check for the dispute round surface (run: pnpm check:dispute-round).
 *
 * `/disputes` is the arbiter queue: the page an arbiter opens when the
 * notification says a dispute picked them. Its card used to be a SECOND copy
 * of the project room's panel, and that copy resolved the milestone through
 * `useProjects()` — which returns only the viewer's own projects, and an
 * arbiter is in none. So `milestone` was `undefined`, `milestone?.onchainId`
 * was `null`, and every control gated on it silently vanished: an arbiter
 * landed on the page built for them and found a card with no round, no
 * clocks, no tally and three dead buttons. The copy had already drifted from
 * the original too — its reveal skipped the indexer wait and its finalize
 * predicate indexed a milestone with `!`.
 *
 * What has to hold, and only the first is a pure function:
 *
 *   1. The round's gate predicates are ONE set of rules, derived from the
 *      contract. Pinned by driving them.
 *   2. The surface is one component, and it reads the on-chain id off the
 *      dispute rather than off a project list. That is a source property, so
 *      it is asserted below — no DOM is needed to see which handle a
 *      component reaches for.
 *
 * No network, no chain, no React.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requiredReveals, QUORUM } from "../lib/contracts.ts";
import { roundGates, revealWindowOpen, commitWindowOpen, canReveal, canFinalize } from "../lib/dispute-round.ts";

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

// A 3-arbiter round, 3 arbiters, window still open.
const base = {
  arbiters: ["0xa", "0xb", "0xc"],
  arbiterCount: 3,
  commitCount: 3,
  revealCount: 0,
  tally: [0, 0, 0],
  commitDeadline: 2000,
  revealDeadline: 3000,
  resolved: false,
  winningOutcome: 0,
  phase: "commit" as const,
};
const g = roundGates(base, 1000);

console.log("\nround gates (what a control is allowed to offer)");

check("a live round can be committed to", g.canCommit);
check("a commit-phase round is not yet revealable", !g.canReveal);
check("a live round cannot be tallied before the deadline", !g.canTally);
check("a live round cannot be finalized", !g.canFinalize);
check("no appeal is open before a tally", !g.appealOpen);
check("the appeal countdown is null before a tally", g.appealEndsAt === null);

// Below quorum the tally is still valid — Escrow._tally falls back to a refund
// of the opener and returns the milestone to Submitted. Gating this off is how
// a thin panel strands a milestone forever.
check(
  "a tally is still offered below quorum (the chain falls back)",
  roundGates({ ...base, phase: "reveal" as const, revealCount: 1 }, 4000).canTally,
  "hiding it below quorum leaves the milestone disputed with no way out",
);

// Escrow.resolveDispute: `block.timestamp <= revealDeadline && revealCount <
// arbiterCount` reverts. After the deadline, or early once everyone revealed.
check(
  "the reveal deadline opens the tally",
  roundGates({ ...base, phase: "reveal" as const, revealCount: 1 }, 3001).canTally,
);
check(
  "still closed one second before the deadline",
  !roundGates({ ...base, phase: "reveal" as const, revealCount: 1 }, 3000).canTally,
);
check(
  "an early tally is open once every arbiter has revealed",
  roundGates({ ...base, phase: "reveal" as const, revealCount: 3 }, 1000).canTally,
);
check(
  "an early tally stays closed while one arbiter is still out",
  !roundGates({ ...base, phase: "reveal" as const, revealCount: 2 }, 1000).canTally,
);
check("a resolved round cannot be tallied again", !roundGates({ ...base, resolved: true, phase: "resolved" as const }, 9999).canTally);

// Escrow.finalizeDispute: `block.timestamp <= revealDeadline + appealWindow`
// reverts. The appeal window is the same window Escrow.appeal is gated on, so
// the appeal button and the finalize button are exact complements — that is
// why one predicate can drive both.
const tallied = { ...base, resolved: true, revealCount: 3, phase: "resolved" as const };
const tg = roundGates(tallied, 3500, 1000);
check("the appeal window is open just after the tally", tg.appealOpen);
check("finalize is closed while the appeal window is open", !tg.canFinalize);
check("the finalize countdown is the appeal deadline", tg.appealEndsAt === 4000);
check("appeal is open at the last second of the window", roundGates(tallied, 4000, 1000).appealOpen);
check("finalize is open one second after the window", roundGates(tallied, 4001, 1000).canFinalize);
check("appeal is closed once the window passed", !roundGates(tallied, 4001, 1000).appealOpen);
check(
  "the two windows are complements, never both open",
  [3000, 3001, 3999, 4000, 4001, 9999].every((t) => roundGates(tallied, t, 1000).appealOpen !== roundGates(tallied, t, 1000).canFinalize),
  "a dispute with both a live appeal and a live finalize lets a party pay to appeal a payout that already moved",
);

console.log("\ncommit / reveal windows (Escrow.commitVote, Escrow.revealVote)");

// commitVote: `block.timestamp > commitDeadline` reverts, so the deadline
// second itself is still committable. revealVote: `<= commitDeadline` reverts,
// so the same second is NOT revealable. They meet exactly at the boundary.
check("the last commit second is still open", commitWindowOpen(2000, 2000));
check("one second later the commit window is shut", !commitWindowOpen(2001, 2000));
check("the reveal window opens the second after the commit deadline", revealWindowOpen(2001, 2000, 3000));
check("the commit-deadline second is not yet revealable", !revealWindowOpen(2000, 2000, 3000));
check("the last reveal second is still open", revealWindowOpen(3000, 2000, 3000));
check("one second later the reveal window is shut", !revealWindowOpen(3001, 2000, 3000));

console.log("\nquorum (Escrow._requiredReveals)");

check("a full 3-panel decides on 2", requiredReveals(3) === QUORUM);
check("a 2-arbiter round decides on both", requiredReveals(2) === 2);
check("a 1-arbiter round decides on its only vote", requiredReveals(1) === 1);
check("requiredReveals never exceeds the panel", [1, 2, 3].every((n) => requiredReveals(n) <= n && requiredReveals(n) >= 1));

console.log("\nreveal guard (a lost salt must be visible, not a silent no-op)");

check("a held salt can be revealed", canReveal({ hasSalt: true, isSelected: true, myRevealed: false }));
check("no salt means the arbiter can never reveal this round", !canReveal({ hasSalt: false, isSelected: true, myRevealed: false }));
check("a revealed vote cannot be revealed twice", !canReveal({ hasSalt: true, isSelected: true, myRevealed: true }));
check("a non-selected arbiter never reveals", !canReveal({ hasSalt: true, isSelected: false, myRevealed: false }));

console.log("\nfinalize gate (used by the panel, exported for the check)");

check("a long-passed appeal window allows finalize", canFinalize({ resolved: true, appealEndsAt: 4000 }, 9999));
check("a live appeal window blocks finalize", !canFinalize({ resolved: true, appealEndsAt: 4000 }, 3500));
check("finalize opens one second after the window", canFinalize({ resolved: true, appealEndsAt: 4000 }, 4001));
check("an unresolved round has nothing to finalize", !canFinalize({ resolved: false, appealEndsAt: 4000 }, 9999));
check("a round with no appeal deadline cannot be finalized", !canFinalize({ resolved: true, appealEndsAt: null }, 9999));

console.log("\none surface, and it reads the id off the dispute");

const panel = read("components/dispute-panel.tsx");
const queue = read("app/(app)/disputes/page.tsx");
const room = read("app/(app)/projects/[id]/page.tsx");

check("the queue renders the shared panel", /<DisputePanel dispute=\{dispute\}/.test(queue));
check("the project room renders the same shared panel", /<DisputePanel dispute=\{dispute\}/.test(room));
// Comments are stripped first: both files name the removed call in prose, which
// is the point of the comment and must not satisfy the assertion.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const panelCode = code(panel);
const queueCode = code(queue);
const roomCode = code(room);

check(
  "the queue no longer resolves a milestone from the project list",
  !/useProjects/.test(queueCode),
  "the list is the viewer's own projects — empty for an arbiter, so every control gated on it disappeared",
);
check(
  "the panel takes the on-chain id from the dispute, not a project list",
  /const onchainId = dispute\.onchainId/.test(panelCode) && !/useProjects/.test(panelCode),
);
check(
  "no component reaches for a milestone the API already named",
  !/milestones\?\.find/.test(panel),
  "the milestone is on the dispute row now",
);
check("the queue's own copy of the round UI is gone", !/useRoundState/.test(queueCode));
check("the project room's own copy of the round UI is gone", !/useRoundState/.test(roomCode));
check("appeal is gated on the appeal window, not merely on a tally", /isParty && appealOpen/.test(panelCode));
// Gated on the PAYOUT, not the tally. `finalized` is stamped by the chain's
// DisputeFinalized (the tally), so gating on it deleted the finalize button —
// the only call that moves the escrowed ETH — the moment a round was tallied.
check("finalize is gated on the same window, so the two cannot both be live", /const settled = dispute\.status === "resolved"/.test(panelCode) && /canFinalize = !settled && \(gates\?\.canFinalize/.test(panelCode));
check("the tally flag never gates the payout controls", !/!dispute\.finalized &&/.test(panelCode), "`finalized` is the tally, not the payout — gating on it strands the escrow");
check("the finalize predicate cannot throw on a missing milestone", !/find\(m\) => m\.id === dispute\.milestoneId\)/.test(panelCode));
check("every gate comes from roundGates, not from a local re-derivation", /roundGates\(round, now, windows\.appeal\)/.test(panelCode) && !/now > round\.revealDeadline \|\| allRevealed/.test(panelCode));
check("a lost salt is stated, not silently rendered as a dead button", /salt is gone/.test(panelCode) && /canReveal/.test(panelCode));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures === 0 ? "all good" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
