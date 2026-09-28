/**
 * Flow helpers for the multi-arbiter dispute lifecycle. These hide the
 * commit-reveal mechanics so tests read as intent ("arbiters vote 2-1 Release").
 */
import { connection, commitHash, randSalt, getRound } from "./fixtures.ts";

const { networkHelpers } = connection;

/** Commit a hidden vote from `arbiter` for the chosen outcome. */
export async function commit(
  escrow: any,
  arbiter: { account: { address: `0x${string}` } },
  milestoneId: bigint,
  round: number,
  outcome: number,
  saltSeed: number,
) {
  const salt = randSalt(saltSeed);
  const hash = commitHash(outcome, salt, arbiter.account.address, milestoneId, round);
  await escrow.write.commitVote([milestoneId, round, hash], { account: arbiter.account });
  return salt;
}

/** Reveal a previously committed vote. */
export async function reveal(
  escrow: any,
  arbiter: { account: { address: `0x${string}` } },
  milestoneId: bigint,
  round: number,
  outcome: number,
  salt: `0x${string}`,
) {
  await escrow.write.revealVote([milestoneId, round, outcome, salt], { account: arbiter.account });
}

/** Advance time past the commit deadline so reveals are allowed. */
export async function passCommitWindow(escrow: any, milestoneId: bigint, round: number) {
  const r = await getRound(escrow, milestoneId, round);
  await networkHelpers.time.increaseTo(Number(r.commitDeadline) + 1);
}

/** Advance time past the reveal deadline so the tally can run. */
export async function passRevealWindow(escrow: any, milestoneId: bigint, round: number) {
  const r = await getRound(escrow, milestoneId, round);
  await networkHelpers.time.increaseTo(Number(r.revealDeadline) + 1);
}

/** Advance time past the appeal window so the decision can be finalized/payout. */
export async function passAppealWindow(escrow: any, milestoneId: bigint, round: number) {
  const r = await getRound(escrow, milestoneId, round);
  const appealWindow = Number(await escrow.read.appealWindow());
  await networkHelpers.time.increaseTo(Number(r.revealDeadline) + appealWindow + 1);
}

/** Tally a round then finalize it (payout) after the appeal window. */
export async function tallyAndFinalize(escrow: any, milestoneId: bigint, round: number, account: any) {
  if (round === 0) await escrow.write.resolveDispute([milestoneId], { account });
  else await escrow.write.resolveAppeal([milestoneId], { account });
  await passAppealWindow(escrow, milestoneId, round);
  await escrow.write.finalizeDispute([milestoneId], { account });
}

/**
 * Convenience: every selected arbiter commits `outcome`, then reveals it.
 * `outcomes[i]` overrides the outcome for arbiter i (default: all same).
 */
export async function commitRevealAll(
  escrow: any,
  milestoneId: bigint,
  round: number,
  arbiterWallets: { account: { address: `0x${string}` } }[],
  outcome: number,
  overrides: Record<string, number> = {},
) {
  const salts = new Map<string, `0x${string}`>();
  for (let i = 0; i < arbiterWallets.length; i++) {
    const w = arbiterWallets[i]!;
    const o = overrides[w.account.address.toLowerCase()] ?? outcome;
    const salt = await commit(escrow, w, milestoneId, round, o, i + 1000 + round * 10);
    salts.set(w.account.address.toLowerCase(), salt);
  }
  await passCommitWindow(escrow, milestoneId, round);
  for (let i = 0; i < arbiterWallets.length; i++) {
    const w = arbiterWallets[i]!;
    const o = overrides[w.account.address.toLowerCase()] ?? outcome;
    await reveal(escrow, w, milestoneId, round, o, salts.get(w.account.address.toLowerCase())!);
  }
}

/** Resolve the selected arbiters of a round to their wallet objects. */
export function walletsFor(
  round: Awaited<ReturnType<typeof getRound>>,
  allWallets: { account: { address: `0x${string}` } }[],
) {
  const map = new Map(allWallets.map((w) => [w.account.address.toLowerCase(), w]));
  return round.arbiters
    .slice(0, round.arbiterCount)
    .map((a) => map.get(a.toLowerCase()))
    .filter((w): w is (typeof allWallets)[number] => !!w);
}
