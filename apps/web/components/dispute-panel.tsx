"use client";

/**
 * The dispute surface — ONE owner for "what the round looks like and what this
 * seat owes".
 *
 * It used to be two copies: `DisputePanel` in the project room and `DisputeCard`
 * on `/disputes`. They had already drifted — the queue's reveal skipped the
 * indexer wait, its finalize predicate indexed a milestone with `!`, and both
 * copies took their clocks from different places. Worse, the queue's copy
 * resolved the milestone through `useProjects()`, which is scoped to the
 * viewer's OWN projects: an arbiter is in none, so `milestone` was `undefined`,
 * `milestone?.onchainId` was `null`, and every control gated on it silently
 * disappeared. The page built for arbiters showed parties' disputes and gave
 * arbiters nothing to do with them.
 *
 * The API now states the two facts a seat needs — the milestone's on-chain id
 * and whether the caller is a party — so this component never has to reach for
 * a project it may not be allowed to read.
 */
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { del } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import {
  useChainAction, commitVoteAction, revealVoteAction, tallyDisputeAction,
  finalizeDisputeAction, appealDisputeAction,
} from "@/lib/chain-actions";
import {
  useRoundState, useDisputeWindows, useNow, computeCommitHash, makeSalt,
  saveCommit, loadCommit, clearCommit, outcomeLabel, roundGates, canReveal,
} from "@/lib/dispute-round";
import { DISPUTE_OUTCOME, requiredReveals } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { formatEth, shortAddress, timeUntil, toWei } from "@/lib/format";
import { press, AddressText } from "@/components/design";
import { Button } from "@/components/ui/button";
import { HandCoins, SealCheck } from "@/components/icons";
import { toast } from "sonner";
import type { DisputeView } from "@/lib/types";

const OUTCOMES = ["release", "refund", "split"] as const;
type Outcome = keyof typeof DISPUTE_OUTCOME;

export function DisputePanel({ dispute, compact = false }: { dispute: DisputeView; compact?: boolean }) {
  const session = useSession();
  const { address } = useWallet();
  const invalidate = useInvalidate();
  const chain = useChainAction();
  const { disputeFeeWei } = useRuntime();
  const onchainId = dispute.onchainId;
  const { round, read: roundRead } = useRoundState(dispute, onchainId);
  const windows = useDisputeWindows();
  const now = useNow();
  const [picked, setPicked] = useState<Outcome | null>(null);
  const active = chain.active;

  const isParty = dispute.isParty;
  const roundIndex = dispute.round ?? 0;
  // The reveal window lasts a day and the salt lives in this browser, so the
  // picker has to come back already holding what was committed. A hardcoded
  // default meant the first Reveal click after a reload matched nothing, raised
  // "Outcome differs from your commit", and did nothing else. Seeding it here
  // fixes the reveal controls too — they take `outcome` from this state.
  const outcome = picked ?? ((loadCommit(dispute.id, roundIndex)?.outcome as Outcome | undefined) ?? "split");
  const setOutcome = (o: Outcome) => setPicked(o);

  const me = address?.toLowerCase();
  const iAmSelected = round?.arbiters.some((a) => a.toLowerCase() === me) ?? false;
  const myCommitted = dispute.committedArbiters?.some((a) => a.toLowerCase() === me) ?? false;
  const myRevealed = dispute.revealedArbiters?.some((a) => a.toLowerCase() === me) ?? false;
  // Every gate below is a transcription of an Escrow check; they live in
  // `roundGates` so the queue and the project room cannot disagree about when
  // a window closes. `check:dispute-round` drives them against the contract.
  const gates = round ? roundGates(round, now, windows.appeal) : null;
  const canCommit = gates?.canCommit ?? false;
  const canRevealNow = canReveal({
    isSelected: iAmSelected,
    hasSalt: !!loadCommit(dispute.id, roundIndex),
    myRevealed,
  });
  const canRevealRound = gates?.canReveal ?? false;
  const canTally = gates?.canTally ?? false;
  // `finalized` flips at TALLY (the chain's DisputeFinalized — "a quorum ruled").
  // Paying the money out is a SEPARATE permissionless tx, and only its
  // DisputeResolved event sets `status: "resolved"`. Every payout/appeal control
  // below used to gate on `!dispute.finalized`, so the instant a round was
  // tallied the Finalize button — the only thing that can move the escrowed ETH —
  // was deleted along with the appeal window, and the row left the open queue on
  // /disputes saying "Settled". Gate on the payout, not on the tally.
  //
  // The chain's own milestone status is the second half of that answer, and it is
  // the one that cannot lag: `finalizeDispute` and `appeal` both require
  // `Disputed`, so a milestone the chain has already moved out of `Disputed`
  // (a no-quorum tally refunds the client inside `resolveDispute`) retires every
  // control below even while the mirror row still says `open`.
  const settled = dispute.status === "resolved" || (!!gates && !gates.live);
  const appealOpen = !settled && (gates?.appealOpen ?? false);
  const canFinalize = !settled && (gates?.canFinalize ?? false);
  const appealEndsAt = settled ? null : gates?.appealEndsAt ?? null;
  const finalizeInSecs = appealEndsAt !== null ? appealEndsAt - now : 0;
  // Below quorum the tally is still valid — the contract refunds the opener AND
  // the whole milestone to the client, and the round is over.
  const required = round ? requiredReveals(round.arbiterCount) : 0;
  const belowQuorum = !!round && !round.resolved && round.revealCount < required;
  // …and once that has happened, the row is closed rather than awaiting a payout.
  const noQuorumSettled = !!round && round.resolved && !!gates && !gates.live
    && round.revealCount < required;
  // A record with no round is a write that never reached the chain. Only a
  // party can retry or discard it; an arbiter can only wait. Gated on a
  // COMPLETED read: `useRoundState` returns null while the first read is in
  // flight and forever after a relay failure, and both used to render this
  // false claim — plus a destructive Discard button that then 409s.
  const awaitingOpen = !settled && onchainId !== null && roundRead && !round;

  const refresh = () => {
    invalidate.disputes();
    invalidate.project(dispute.projectId);
  };

  return (
    <div className="space-y-4">
      {/* The record exists but no on-chain round: the opener's wallet tx never
        landed. Nothing is votable or talliable until it does. */}
      {awaitingOpen && (
        <div className="num border-2 border-state-funded/50 bg-state-funded/10 px-4 py-3 text-[13px] text-state-funded">
          Waiting for the on-chain open — {isParty
            ? "re-send the opening transaction from the project room, or discard the record below."
            : "a party still has to send the opening transaction."}
          {isParty && (
            <button
              type="button"
              disabled={active}
              onClick={async () => {
                try {
                  await del(`/projects/${dispute.projectId}/milestones/${dispute.milestoneId}/disputes`);
                  invalidate.disputes();
                  toast.success("Record discarded", { description: "No round existed on-chain — post again to retry the open." });
                } catch (err) {
                  toast.error("Could not discard", { description: err instanceof Error ? err.message : "Unknown error" });
                }
              }}
              className="mt-1.5 block font-medium underline underline-offset-2 hover:text-white disabled:opacity-50"
            >
              Discard this record
            </button>
          )}
        </div>
      )}

      {/* round summary */}
      <div className={`grid gap-2.5 text-center ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        <Stat label="round" value={String(roundIndex + 1)} />
        <Stat label="arbiters" value={round ? `${round.arbiterCount}` : "—"} />
        <Stat label="committed" value={round ? `${round.commitCount}` : "—"} />
        <Stat label="revealed" value={round ? `${round.revealCount}/${round.arbiterCount}` : "—"} />
      </div>

      {round && !round.resolved && (
        <div className="num border-2 border-line bg-ink-raised px-4 py-3 text-[13px] text-faint">
          {round.phase === "commit" && <>commit window closes {timeUntil(new Date(round.commitDeadline * 1000).toISOString())}</>}
          {round.phase === "reveal" && now <= round.revealDeadline && <>reveal window closes {timeUntil(new Date(round.revealDeadline * 1000).toISOString())}</>}
          {round.phase === "reveal" && now > round.revealDeadline && <>reveal window closed — tally is available</>}
          {round.revealCount < round.arbiterCount && round.phase === "reveal" && (
            <span className="text-state-funded"> · waiting on {round.arbiterCount - round.revealCount} arbiter(s)</span>
          )}
        </div>
      )}

      {/* selected arbiters + what each has done */}
      {round && round.arbiters.length > 0 && (
        <div className="space-y-1.5">
          <div className="num text-[13px] uppercase tracking-wider text-faint">selected arbiters</div>
          <div className="flex flex-wrap gap-2">
            {round.arbiters.map((a) => {
              const revealed = (dispute.revealedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
              const committed = (dispute.committedArbiters ?? []).some((x) => x.toLowerCase() === a.toLowerCase());
              return (
                <span key={a} className={`num inline-flex items-center gap-1.5 border-2 px-3 py-1 text-[13px] ${revealed ? "border-state-released/40 text-state-released" : committed ? "border-line-strong text-dim" : "border-line text-faint"}`}>
                  <AddressText value={a} size={4} />
                  <span className="text-[13px] opacity-70">{revealed ? "revealed" : committed ? "committed" : "pending"}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* live tally */}
      {round && (round.revealCount > 0 || dispute.finalized) && (
        <div className="grid grid-cols-3 gap-2 text-center">
          {(["Release", "Refund", "Split"] as const).map((label, i) => (
            <div key={label} className="border-2 border-line bg-ink-raised px-3 py-2">
              <div className="num text-[13px] uppercase tracking-wider text-faint">{label}</div>
              <div className="num mt-0.5 text-[16px]">{round.tally[i] ?? 0}</div>
            </div>
          ))}
        </div>
      )}

      {/* arbiter voting */}
      {iAmSelected && !settled && round && !round.resolved && onchainId !== null && (
        <div className="space-y-3 border-t-2 border-line pt-4">
          <div className="flex items-center gap-2 text-[14px] font-medium text-rose-bright">
            <HandCoins className="h-4 w-4" /> You are a selected arbiter
          </div>

          {canCommit && (
            <>
              <p className="text-[13px] leading-relaxed text-faint">
                Choose your ruling and commit the hash now. Your choice stays hidden until the reveal phase — this
                prevents anyone copying a vote.
              </p>
              <OutcomePicker outcome={outcome} setOutcome={setOutcome} />
              <Button
                disabled={active || myCommitted}
                onClick={async () => {
                  const salt = makeSalt();
                  const hash = computeCommitHash(DISPUTE_OUTCOME[outcome], salt, address!, toWei(onchainId), roundIndex);
                  const result = await commitVoteAction(chain.run)(onchainId, roundIndex, hash, dispute.projectId);
                  if (result.ok) {
                    // Stash the salt so the reveal step can find it; losing it
                    // means the commit can't be revealed.
                    saveCommit(dispute.id, roundIndex, outcome, salt);
                    refresh();
                  }
                }}
                className="w-full"
              >
                {myCommitted ? "Committed — wait for reveal" : `Commit "${outcome === "split" ? "Split 50/50" : outcome}"`}
              </Button>
            </>
          )}

          {canRevealRound && canRevealNow && (
            <RevealControls
              dispute={dispute}
              onchainId={onchainId}
              roundIndex={roundIndex}
              outcome={outcome}
              setOutcome={setOutcome}
              onDone={refresh}
            />
          )}

          {myRevealed && <p className="text-[13px] text-state-released">Your vote is revealed. Waiting for the tally.</p>}

          {/* The one state no button can move: a commitment the contract will
              hold but this device can no longer satisfy. The salt was never
              sent anywhere, so a lost commit is a vote lost for the round —
              and the other arbiters need to know the tally is short. */}
          {canRevealRound && myCommitted && !myRevealed && !canRevealNow && (
            <p className="border-2 border-state-funded/50 bg-state-funded/10 px-4 py-3 text-[13px] leading-relaxed text-state-funded">
              You committed on this device, but the salt is gone — a commit can only be revealed from the browser
              that made it, so this vote cannot be recovered. The other arbiters can still reach quorum without it.
            </p>
          )}
        </div>
      )}

      {/* tally + finalize (permissionless) */}
      {!settled && onchainId !== null && (
        <div className="space-y-2.5 border-t-2 border-line pt-4">
          {/* What happens next, in one sentence, per seat: an arbiter waits on
              a window, a party sees the appeal they still own. The finalize
              countdown IS the appeal window, so both read from one clock. */}
          {isParty && round?.resolved && !settled && (
            <p className="text-[13px] text-faint">
              {appealOpen
                ? `You may still appeal for ${timeUntil(new Date(appealEndsAt! * 1000).toISOString())} — a fresh panel of arbiters re-decides it and the current majority is penalised if it was wrong.`
                : "The appeal window has closed — anyone can finalize the payout."}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline"
              disabled={active || !canTally}
              onClick={async () => {
                const result = await tallyDisputeAction(chain.run)(onchainId, roundIndex, dispute.projectId);
                if (result.ok) refresh();
              }}
              
            >
              Tally round
            </Button>
            <Button
              disabled={active || !canFinalize}
              onClick={async () => {
                const result = await finalizeDisputeAction(chain.run)(onchainId, dispute.projectId, waitResolved);
                if (result.ok) refresh();
              }}
              className="bg-state-released/15 py-2.5 text-[13px] font-medium text-state-released hover:bg-state-released/25"
            >
              {finalizeInSecs > 0 ? `Finalize ${timeUntil(new Date(appealEndsAt! * 1000).toISOString())}` : "Finalize payout"}
            </Button>
          </div>
          {canTally && belowQuorum && round && (
            <p className="text-[13px] text-state-funded">Fewer than {required} reveals — tallying refunds the opener's fee and the whole milestone to the client, and closes the round (no-quorum fallback).</p>
          )}
          {isParty && appealOpen && (
            <Button
              disabled={active}
              onClick={async () => {
                const result = await appealDisputeAction(chain.run)(onchainId, toWei(disputeFeeWei), dispute.projectId);
                if (result.ok) refresh();
              }}
              className="w-full border-2 border-state-disputed/40 py-2 text-[13px] font-medium text-state-disputed hover:bg-state-disputed/10"
            >
              {toWei(disputeFeeWei) > 0n ? `Appeal (${formatEth(disputeFeeWei)} ETH)` : "Appeal (free)"} — penalises a wrong majority
            </Button>
          )}
          {/* Why the other two are shut. A disabled control with no stated
              reason reads as broken; here the reason is always a clock or a
              vote, and both are on screen. */}
          {!canTally && !canFinalize && !canCommit && (
            <p className="text-[13px] text-faint">
              {round?.resolved
                ? "The round is tallied. The payout unlocks when the appeal window closes."
                : round
                  ? `Nothing to do yet — ${round.revealCount < round.arbiterCount ? "the round is still running" : "the round awaits a tally"}.`
                  : "Waiting for the on-chain round to open."}
            </p>
          )}
          {/* Reads never completed: say that, instead of implying the round is
              missing, and do not offer a destructive retry for it. */}
          {onchainId !== null && !roundRead && (
            <p className="text-[13px] text-faint">
              Reading the on-chain round from the relay — controls appear once it answers.
            </p>
          )}
        </div>
      )}

      {settled && (
        <div className="space-y-1.5 border-t-2 border-line pt-4">
          <div className="flex items-center gap-2 text-[14px] text-state-split">
            <SealCheck weight="fill" className="h-4 w-4" />
            Settled — {dispute.outcome ? outcomeLabel(DISPUTE_OUTCOME[dispute.outcome]) : "—"}
            {dispute.resolvedArbiter && <> · majority {shortAddress(dispute.resolvedArbiter)}</>}
          </div>
          {/* The one settlement with no winning side: the panel never reached its
              threshold, so the tally itself refunded the client and closed the
              round. There is no payout left to finalize and no appeal left to
              file — both revert `NotDisputed` on-chain. */}
          {noQuorumSettled && (
            <p className="text-[13px] leading-relaxed text-faint">
              The panel never reached {required} reveals, so the milestone went back to the client in that same
              transaction and the round is closed. There is nothing left to finalize or appeal.
            </p>
          )}
        </div>
      )}

      {/* A rejected signature is a plain object, not an Error, so
          `chain-actions` deliberately suppresses the toast for it — that made
          every one of these five controls fail in total silence. */}
      {chain.error && (
        <p className="border-2 border-state-disputed/30 bg-state-disputed/[0.08] px-4 py-3 text-[13px] leading-relaxed text-state-disputed">
          {chain.error}
        </p>
      )}

      {!settled && onchainId === null && (
        <p className="text-[13px] text-faint">
          {session.user
            ? "This milestone is not on-chain yet — the round cannot open until it is."
            : "Sign in to follow this round."}
        </p>
      )}
    </div>
  );
}

/**
 * The mirror-wait predicate for `finalizeDispute`: some milestone in the
 * project has settled. Defensive by design — this runs on the project view
 * fetched for the indexer poll, and an absent milestone means "not mirrored
 * yet", never a throw. The queue's old copy indexed one milestone with `!` and
 * would have taken the whole write down when it wasn't there.
 */
const SETTLED = ["resolved_release", "resolved_refund", "resolved_split"] as const;
function waitResolved(p: { milestones?: { chainStatus: string }[] }): boolean {
  return (p.milestones ?? []).some((m) => SETTLED.includes(m.chainStatus as typeof SETTLED[number]));
}

function OutcomePicker({ outcome, setOutcome }: { outcome: Outcome; setOutcome: (o: Outcome) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {OUTCOMES.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={outcome === o}
          onClick={() => setOutcome(o)}
          className={`border-2 px-3 py-2 text-[13px] font-medium ${press} ${outcome === o ? "border-rose-accent bg-rose-soft text-foreground" : "border-line text-dim hover:text-foreground"}`}
        >
          {o === "split" ? "Split 50/50" : o}
        </button>
      ))}
    </div>
  );
}

function RevealControls({
  dispute, onchainId, roundIndex, outcome, setOutcome, onDone,
}: {
  dispute: DisputeView;
  onchainId: number;
  roundIndex: number;
  outcome: Outcome;
  setOutcome: (o: Outcome) => void;
  onDone: () => void;
}) {
  const chain = useChainAction();
  const active = chain.active;

  return (
    <>
      <p className="text-[13px] leading-relaxed text-faint">
        Reveal must match your commit exactly (same outcome + salt) — otherwise the transaction reverts.
      </p>
      <OutcomePicker outcome={outcome} setOutcome={setOutcome} />
      <Button variant="outline"
        disabled={active}
        onClick={async () => {
          const saved = loadCommit(dispute.id, roundIndex);
          if (!saved?.salt) {
            toast.error("No saved commit on this device", { description: "You can only reveal where you committed — the salt never leaves that browser." });
            return;
          }
          if (saved.outcome !== outcome) {
            toast.error("Outcome differs from your commit", { description: `You committed “${saved.outcome}” — switched back for you.` });
            setOutcome(saved.outcome as Outcome);
            return;
          }
          const result = await revealVoteAction(chain.run)(
            onchainId, roundIndex, DISPUTE_OUTCOME[outcome], saved.salt, dispute.projectId,
          );
          if (result.ok) {
            clearCommit(dispute.id, roundIndex);
            onDone();
          }
        }}
        className="w-full"
      >
        Reveal "{outcome === "split" ? "Split 50/50" : outcome}"
      </Button>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-line bg-ink-raised px-3 py-2">
      <div className="num text-[13px] uppercase tracking-wider text-faint">{label}</div>
      <div className="num mt-0.5 text-[15px]">{value}</div>
    </div>
  );
}
