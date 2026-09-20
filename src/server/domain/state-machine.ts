/**
 * The milestone state machine (PRD F4/F5), mirrored off-chain:
 *
 *   pending_funding → funded → submitted → released
 *        ↘ cancelled ↘ disputed → resolved_release | resolved_refund | resolved_split
 *   funded → cancelled (client cancel, refund)
 *
 * The CONTRACT enforces legality; the mirror only records what the chain did.
 * If we ever observe an illegal transition, that is drift — logged loudly and
 * left for reconciliation, never silently "fixed".
 */
export type MilestoneStatus =
  | 'pending_funding' | 'funded' | 'submitted' | 'released' | 'disputed'
  | 'resolved_release' | 'resolved_refund' | 'resolved_split' | 'cancelled'

export type ChainEventName =
  | 'MilestoneFunded' | 'MilestoneSubmitted' | 'MilestoneReleased'
  | 'MilestoneRefunded' | 'MilestoneSplit' | 'MilestoneCancelled'
  | 'DisputeOpened' | 'DisputeResolved'
  | 'ArbitersSelected' | 'VoteCommitted' | 'VoteRevealed' | 'DisputeFinalized'
  | 'AppealOpened' | 'AppealResolved' | 'ArbiterRewarded' | 'ArbiterPenalized'
  | 'NoQuorumFallback' | 'RewardsDeposited'
  | 'FeeWithdrawn' | 'ArbiterRegistered' | 'ArbiterDeregistered' | 'TrustScoreUpdated'
  | 'ScoreChanged' | 'StakeDeposited' | 'StakeWithdrawn' | 'StakeSlashed' | 'StakeLocked'
  | 'UnstakeRequested' | 'UnstakeCancelled' | 'TierThresholdsUpdated'
  | 'MinStakeUpdated' | 'MinScoreToWithdrawUpdated' | 'MinStakeDurationUpdated'
  | 'UnstakeCooldownUpdated' | 'EscrowSet'

/** Legal (from, event) → to. Everything else is drift. */
const TRANSITIONS: Partial<Record<ChainEventName, Partial<Record<MilestoneStatus, MilestoneStatus>>>> = {
  MilestoneFunded: { pending_funding: 'funded' },
  MilestoneSubmitted: { funded: 'submitted' },
  DisputeOpened: { funded: 'disputed', submitted: 'disputed' },
  MilestoneReleased: {
    submitted: 'released',
    disputed: 'resolved_release', // arbiter resolution: release
  },
  MilestoneRefunded: {
    funded: 'cancelled', // client cancel (no dispute)
    disputed: 'resolved_refund', // arbiter resolution: refund
  },
  MilestoneSplit: { disputed: 'resolved_split' },
  MilestoneCancelled: { pending_funding: 'cancelled', funded: 'cancelled' },
}

export function nextMilestoneStatus(from: MilestoneStatus, event: ChainEventName): { to: MilestoneStatus; legal: boolean } {
  const to = TRANSITIONS[event]?.[from]
  if (to) return { to, legal: true }
  // An already-terminal state receiving its own terminal event again is handled
  // upstream as a duplicate log (idempotency), not here. Anything else is drift.
  return { to: from, legal: false }
}

/** Terminal = no further money movement possible for this milestone. */
export const TERMINAL: readonly MilestoneStatus[] = [
  'released', 'resolved_release', 'resolved_refund', 'resolved_split', 'cancelled',
] as const

export function isTerminal(s: MilestoneStatus): boolean {
  return (TERMINAL as readonly string[]).includes(s)
}

/**
 * Settlement = the milestone ended via approval or dispute resolution, which
 * UNLOCKS transaction-bound reviews for both parties (PRD: "the resolution
 * itself unlocks reviews"). A client-side cancel does NOT unlock reviews —
 * the freelancer delivered nothing to review.
 */
export function unlocksReviews(s: MilestoneStatus): boolean {
  return s === 'released' || s === 'resolved_release' || s === 'resolved_refund' || s === 'resolved_split'
}

/** True when the freelancer received value (drives derived user stats). */
export function freelancerReceivedValue(s: MilestoneStatus): boolean {
  return s === 'released' || s === 'resolved_release' || s === 'resolved_split'
}

/** Milestone states in which a party may open a dispute (funds locked). */
export function isDisputable(s: MilestoneStatus): boolean {
  return s === 'funded' || s === 'submitted'
}
