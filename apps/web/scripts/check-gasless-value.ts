/**
 * Self-check for the gasless-relay rule (run: pnpm check:gasless).
 *
 * The relayer sponsors STATE CHANGES, never value movement:
 *
 *   IN  — `SponsorshipForwarder.execute` is payable and forwards `req.value`
 *         out of the RELAYER's balance. While every money action was relayed, an
 *         arbiter deposit was funded by the platform: the wallet showed only an
 *         EIP-712 signature, the balance never moved, no transfer confirmation
 *         appeared, and the stake a slash would consume was the relayer's ETH.
 *         Escrow funding, top-ups and dispute fees failed the same way.
 *   OUT — a withdrawal pays the arbiter's own collateral back, and is a money
 *         action they should see and pay for like their deposit.
 *
 * So a call may only be relayed when it is zero-value AND not marked
 * `userPaid`. Everything else — submit, approve, cancel, votes, tally, finalize,
 * unstake request/cancel, fee withdrawal — stays gasless.
 *
 * The second half drives the real action factories through a spy `run`, so the
 * rule is pinned where it is actually declared, not just in the predicate.
 */
import {
  canRelayGasless,
  registerArbiterWithStakeAction,
  addStakeAction,
  withdrawStakeAction,
  requestUnstakeAction,
  submitMilestoneAction,
} from "../lib/chain-actions.ts";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const ETH = 10n ** 18n;

/** What a named action actually asks `run` for. */
interface RunOpts {
  functionName: string;
  value?: bigint;
  userPaid?: boolean;
}

/** JSON.stringify that survives the bigint `value` these options carry. */
function show(o: RunOpts): string {
  return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v} wei` : v));
}

/** Call a real action with a spy `run` and return the options it produced. */
async function optsFor(invoke: (run: never) => Promise<unknown>): Promise<RunOpts> {
  let captured!: RunOpts;
  const spy = (async (o: RunOpts) => {
    captured = o;
    return { ok: true, hash: null };
  }) as never;
  await invoke(spy);
  return captured;
}

async function main() {
  console.log("sponsorship relay rule");

  // 1. Value in — never relayed.
  check("stake deposit is never relayed", !canRelayGasless({ value: ETH }));
  check("stake top-up is never relayed", !canRelayGasless({ value: 3n * ETH }));
  check("escrow funding is never relayed", !canRelayGasless({ value: 250n * ETH }));
  check("dispute fee is never relayed", !canRelayGasless({ value: 1n }));

  // 2. Value out — never relayed.
  check("a userPaid call is never relayed", !canRelayGasless({ userPaid: true }));
  check("userPaid wins even alongside a value", !canRelayGasless({ userPaid: true, value: 5n }));

  // 3. Bookkeeping with no principal — still gasless.
  check("a zero-value call is relayed", canRelayGasless({ value: 0n }));
  check("a call with no value at all is relayed", canRelayGasless({}));

  // 4. The wiring — what the real actions ask for, not just what the rule says.
  const withdraw = await optsFor((r) => withdrawStakeAction(r)());
  check("withdrawStake declares itself user-paid", withdraw.userPaid === true, show(withdraw));
  check("withdrawStake is not relayed", !canRelayGasless(withdraw));

  const deposit = await optsFor((r) => registerArbiterWithStakeAction(r)(ETH));
  check("stake deposit carries its value", deposit.value === ETH && deposit.userPaid !== true, show(deposit));
  check("stake deposit is not relayed", !canRelayGasless(deposit));

  const topUp = await optsFor((r) => addStakeAction(r)(2n * ETH));
  check("stake top-up is not relayed", !canRelayGasless(topUp));

  const request = await optsFor((r) => requestUnstakeAction(r)());
  check("unstake request stays gasless", canRelayGasless(request), show(request));

  const submit = await optsFor((r) => submitMilestoneAction(r)(1, "p", () => true));
  check("milestone submit stays gasless", canRelayGasless(submit), show(submit));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed — a relayed value moves the relayer's ETH, not the user's.`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

void main();
