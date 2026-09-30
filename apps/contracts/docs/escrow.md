# Escrow — integration reference

Source: `contracts/Escrow.sol` (UUPS upgradeable, owner = `OpenLanceTimelock`).

One contract holds every milestone. Fee and settlement logic is cross-project, so
there is a single accounting surface rather than per-project clones.

**Every sequence below was executed against the test suite** (`test/escrow.ts`,
`test/drawdown.ts`, `test/disputes.ts`, `test/disputeFlow.ts`). Claims that the
README made but the code does not implement are called out in
[Known behaviour](#known-behaviour) — read that section before assuming a flow works.

---

## Status enum (FROZEN — the indexer maps `uint8` → name)

`src/server/chain/events.ts` (`ONCHAIN_MILESTONE_STATUS`) decodes these ordinals.
`test/event-surface.ts` pins `Funded == 1` and `Submitted == 2`.

| Ordinal | Name | Meaning | Terminal |
|---|---|---|---|
| 0 | `PendingFunding` | off-chain template row, never funded | no |
| 1 | `Funded` | escrowed, work not started | no |
| 2 | `Submitted` | freelancer delivered, awaiting client | no |
| 3 | `Disputed` | locked into arbitration | no |
| 4 | `Released` | client approved | **yes** |
| 5 | `ResolvedRelease` | arbitration ruled release | **yes** |
| 6 | `ResolvedRefund` | arbitration ruled refund | **yes** |
| 7 | `ResolvedSplit` | arbitration ruled split | **yes** |
| 8 | `Cancelled` | client cancelled pre-submission | **yes** |

`Outcome` (frozen): `Release = 0`, `Refund = 1`, `Split = 2`.

Milestone ids start at **1** — `nextMilestoneId` is initialised to 1 and id 0 never exists.
`milestoneStatus` and `getMilestone` **revert** `UnknownMilestone` for id `0` or any
id `>= nextMilestoneId`; they never return a default status.

---

## Flow 1 — job budget drawdown (the award path)

The client pays the wallet **once** at publish. Every milestone of that job is then
funded from the locked balance, so no per-milestone funding signature is needed as
work starts. This is what the backend's award flow calls.

```
lockBudget{value: totalBudget}(jobRef)          ← client, once per job
        │
        ├─ fundAllFromCredit(jobRef, refs[], freelancers[], amounts[])   ← batch, all-or-nothing
        │   or fundFromCredit(jobRef, ref, freelancer, amount)          ← one at a time
        │
        ├─ per milestone:  submit(id) → approve(id) → withdrawMilestone(id)
        │                  or cancel(id) while Funded
        │
        └─ unlockBudget(jobRef, amount)          ← free balance only
```

- `jobRef` / `ref` are `bytes32` of the off-chain uuid. `ref` is the indexer join key.
- `fundAllFromCredit` sums `amounts` **once** and checks the total against the free
  balance, so a single bad item reverts the whole batch with nothing reserved
  (`BadBatch` for mismatched array lengths, `InsufficientBudget` for an overdraft).
- No ETH is attached to `fundFromCredit` / `fundAllFromCredit` — value is already locked.
- `unlockBudget` pays the client the free balance. `paidOutBudget` is incremented
  **before** the transfer (CEI).

Per-job balance sheet:

```
free      = lockedBudget - paidOutBudget - reservedBudget     ← drawable and unlockable
reserved  = wei drawn into milestones that are still unsettled
paidOut   = wei released by a settlement, cancel, or unlock
invariant = reservedBudget + paidOutBudget <= lockedBudget
```

`_settleBudget` moves a milestone's whole `amount` from `reserved` to `paidOut` on
`approve`, `cancel`, or any dispute settlement. Wallet-funded milestones carry
`jobRef == bytes32(0)` and touch no budget.

**Reentrancy:** `fundFromCredit`, `fundAllFromCredit`, `unlockBudget` are `nonReentrant`.

## Flow 2 — wallet-funded single milestone (legacy path)

```
fund{value: amount}(ref, freelancer)   ← client
  → submit(id)        freelancer: work delivered
  → approve(id)       client: accepts        → withdrawMilestone(id)  freelancer pulls
  → cancel(id)        client: aborts while Funded, full refund pushed
```

`fund` rejects `amount == 0` (`ZeroAmount`) and `freelancer == 0 || freelancer == client`
(`InvalidFreelancer`). It is **not** `nonReentrant` — it makes no external calls.

`feeBps` is **snapshotted at funding time** into the milestone. Changing the platform
fee later never touches in-flight milestones.

## Flow 3 — release settlement is a two-step pull

`approve` does **not** push ETH. It:

1. sets `status = Released`,
2. `accruedFees += floor(amount * feeBps / 10000)`,
3. `claimable[id] = amount - fee`,
4. calls `_settleBudget` (fee + principal both leave the job's balance sheet).

The freelancer then calls `withdrawMilestone(id)`, which zeroes `claimable` before
transferring. `withdrawMilestone` is valid for `Released`, `ResolvedRelease` and
`ResolvedSplit`, and reverts `NothingToWithdraw` on a second call.

Client refunds stay **push** (`cancel`, `ResolvedRefund`, and the client half of
`ResolvedSplit` are transferred inside the settling call).

---

## Flow 4 — dispute

```
openDispute(id)   /* free while disputeFee == 0 */  (or openDisputeWith(id, preferred[3]))
   │
   ├─ COMMIT   commitVote(id, round, hash)          each arbiter, until commitDeadline
   ▼
├─ REVEAL   revealVote(id, round, outcome, salt)  after commitDeadline, until revealDeadline
   ▼
   ├─ TALLY    resolveDispute(id)     round 0
   │           resolveAppeal(id)     round >= 1
   │           └─ no quorum → Refund to the client, MONEY MOVES HERE, round over
   ▼
   ├─ (optional) appeal(id)                        re-draws a fresh round
   ▼
   └─ finalizeDispute(id)           after revealDeadline + appealWindow  ← MONEY MOVES HERE
          ├─ ResolvedRelease / ResolvedSplit → withdrawMilestone(id) by the freelancer
          └─ ResolvedRefund                  → client refunded inside finalizeDispute
```

### Commit hash

```
keccak256(abi.encode(uint8 outcome, bytes32 salt, address arbiter, uint256 milestoneId, uint8 round))
```

`abi.encode`, not `encodePacked`. Prefer the contract's own
`computeCommit(milestoneId, round, outcome, salt, arbiter) → bytes32` view over
recomputing it client-side. `test/fixtures.ts::commitHash` is the reference encoder.

The `arbiter` term binds the hash to the voter, so one arbiter cannot replay another's
commit. `salt` is chosen by the arbiter and must be kept to reveal.

### Selection

- Draws up to `MAX_ARBITERS = 3` without replacement from the registry roster.
- Parties are always excluded. Eligible draws only (`IArbiterRegistry.isEligible`).
- **Degraded panels.** A thin roster opens a round anyway, down to a single arbiter —
  availability over panel size, because a milestone stuck against its parties is worse
  than one judged by a single staked, score-tracked arbiter. The decision threshold
  follows the seated panel (`_requiredReveals`): `min(arbiterCount, QUORUM)`. So a
  1-arbiter round decides on one reveal and a 2-arbiter round still needs both.
  Only an **empty** roster reverts `NotEnoughArbiters(0)` — a panel of zero is not
  arbitration, and the client can `cancel` or the pair can `submit`/`approve` instead.
- `openDisputeWith` honours up to 3 mutually-agreed nominees first. A nominee that is a
  party, a duplicate, or ineligible is **skipped silently** and the slot is filled at
  random — a stale pick can never block dispute opening.
- Randomness is `prevrandao` + block metadata, so it is producer-influenceable.
  Bounded exposure: a biased producer reorders *which* eligible arbiters are drawn;
  money stays gated by the commit-reveal quorum and by staking. On a healthy roster
  that quorum is 2-of-3; on a degraded panel it is the panel itself. See `SECURITY.md`.
- `stakeWeights` are snapshotted at `ArbitersSelected` so an arbiter cannot top up
  their stake after being drawn and seize a larger reward share.

### Timing traps

| Gate | Condition | Error if violated |
|---|---|---|
| commit | `block.timestamp <= commitDeadline` | `CommitDeadlinePassed` |
| reveal | `block.timestamp > commitDeadline` | `CommitDeadlineNotPassed` |
| reveal | `block.timestamp <= revealDeadline` | `RevealWindowClosed` |
| tally | `> revealDeadline` **or** every arbiter already revealed | `RevealWindowOpen` |
| appeal | `pr.resolved == true` **and** `timestamp <= revealDeadline + appealWindow` | `WrongPhase` / `AppealWindowClosed` |
| finalize | `timestamp > revealDeadline + appealWindow` | `AppealWindowOpen` |

Two things integrations get wrong:

- The appeal window **starts at `revealDeadline`, not at resolution**. A party that waits
  to see the tally still only has the remaining slice of that window.
- `finalizeDispute` is what moves money. `resolveDispute` only records the outcome.

### Round selection

`_round` requires `round == d.round`, and `d.round` is the *current* round. Always read
the current round from `getDispute`; a stale round index reverts `NotDisputed`.

`resolveDispute` and `resolveAppeal` both tally `d.round`. For round 0 use
`resolveDispute`; for round >= 1 use `resolveAppeal` — only `resolveAppeal` compares
against the previous outcome and applies the overturn penalty.

### Quorum and payouts

- 2 of 3 reveals decides. A third silent arbiter does not block it.
- Fewer than the round's threshold reveals → **no-quorum fallback**, settled by the
  same `resolveDispute` call: the opener's dispute fee comes back, **and the
  milestone is Refunded to the client** (`ResolvedRefund`, terminal). There is no
  `finalizeDispute` to follow — the round is over and the money has already moved,
  so `finalizeDispute` and `appeal` both revert `NotDisputed`.
- The fallback does **not** return the milestone to `Submitted`. A disputed
  milestone only ever leaves dispute through arbitration, so the client can never
  `approve` a payment no panel agreed to (`WrongStatus` on a terminal status).
- Ties resolve to `Split`.

| Winner | Status | Client | Freelancer | Platform fee | Arbiters |
|---|---|---|---|---|---|
| Release | 5 | — | `claimable = amount - fee` (pull) | 0 (rounding dust only) | milestone fee, stake-weighted |
| Refund | 6 | `amount` (push) | — | 0 — **no fee charged** | dispute fee only |
| Split | 7 | `amount/2` (push) | `claimable = half - feeOn(half)` (pull) | 0 (rounding dust only) | dispute fee + fee on the freelancer half |
| no quorum | 6 | `amount` (push, at tally) | — | 0 | nothing — `d.fee` goes back to the opener |

**Consequence for revenue:** `accruedFees` only grows on the non-disputed `approve` path
(and on rounding dust from a dispute). A disputed release pays the whole platform fee to
the arbiters instead, and a funded `rewardPool` puts more of the protocol's own money
into that pot. Verified: `accruedFees == 0` after a full dispute settlement.

### Rewards

Two separate pots, both split pro-rata by the selection-time `stakeWeights` among the
revealed majority:

1. `d.fee + subsidy` — whatever the opener paid (0 while disputes are free; replaced
   by the appeal fee on appeal) plus a protocol top-up drawn from `rewardPool`.
2. The milestone fee — on `Release` and `Split` only, via `_payArbiterFee`.

**The subsidy.** Opening a dispute is free by default (`disputeFee == 0`), so the
arbiters are paid by the protocol rather than by the opener. `depositRewards` funds
`rewardPool`, and each settlement draws `subsidy = min(rewardPool, disputeReward)`
from it — `disputeReward` is the per-dispute ceiling, owner-set via `setDisputeReward`.
Consequences worth knowing:

- The draw is capped at the pool balance, so a dispute can never pay out more than the
  protocol has already funded. It is a ceiling, not a mint.
- With `disputeFee == 0` and a funded pool, the pot is exactly `disputeReward` — the
  opener's contribution is 0 and the protocol funds the whole round.
- A `disputeFee` retune (owner) makes the opener's payment additive again, exactly as
  before: the pot becomes `d.fee + min(rewardPool, disputeReward)`.
- When the pool runs dry the subsidy is simply 0 and the pot reverts to `d.fee` alone —
  no branch, no failure mode. With a free dispute that means the arbiters earn only the
  milestone fee, so the pool is a standing budget, not a one-off.
- `RewardSubsidized(milestoneId, amount)` reports the draw; `rewardPool` is the
  remaining balance. `sweepRewardPool` (owner) reclaims whatever is left, so this is a
  policy lever, not a permanent commitment.
- Reward-pot rounding dust still accrues back into `rewardPool`, so a dispute with no
  subsidy can fund a later one.

Rounding dust stays in the contract (`rewardPool` for the dispute pot, `accruedFees` for
the milestone fee). `reward_i = pot * weight_i / Σ weight_majority`.

`rewardPool` is credited by rounding dust and by `depositRewards`, and is only ever
drained by `sweepRewardPool` (owner → treasury). **It is never spent on arbiter
rewards** — see [Known behaviour](#known-behaviour).

### Trust score

`_distributeRewards` calls `IArbiterRegistry.applyScoreChange` once per registered,
selected arbiter: majority `+5` (reason 1), minority `−10` (2), never revealed `−15` (3).
`resolveAppeal` additionally applies `−25` (4) to the previous round's selected arbiters
when the outcome changed.

---

## Function reference

### Funding / budget

| Function | Payable | Guarded | Notes |
|---|---|---|---|
| `fund(bytes32 ref, address freelancer)` | yes | — | legacy wallet path; `client = _msgSender()` |
| `lockBudget(bytes32 jobRef)` | yes | — | once per job; `BudgetAlreadyLocked` |
| `fundFromCredit(bytes32 jobRef, bytes32 ref, address freelancer, uint256 amount)` | no | `nonReentrant` | locker only; no ETH attached |
| `fundAllFromCredit(bytes32 jobRef, bytes32[] refs, address[] freelancers, uint256[] amounts)` | no | `nonReentrant` | all-or-nothing batch |
| `unlockBudget(bytes32 jobRef, uint256 amount)` | no | `nonReentrant` | clamped to the free balance |

### Milestone lifecycle

| Function | Caller | Guarded | Notes |
|---|---|---|---|
| `submit(uint256 id)` | freelancer | — | `Funded → Submitted` |
| `approve(uint256 id)` | client | `nonReentrant` | `Submitted → Released`, fee to `accruedFees` |
| `withdrawMilestone(uint256 id)` | freelancer | `nonReentrant` | pull the claimable principal |
| `cancel(uint256 id)` | client | `nonReentrant` | `Funded → Cancelled`, full push refund |

### Dispute

| Function | Payable | Guarded | Notes |
|---|---|---|---|
| `openDispute(uint256 id)` | yes | `nonReentrant` | either party; `Funded` or `Submitted` only |
| `openDisputeWith(uint256 id, address[3] preferred)` | yes | `nonReentrant` | nominees first, random fill |
| `commitVote(uint256 id, uint8 round, bytes32 hash)` | no | — | selected arbiters only |
| `revealVote(uint256 id, uint8 round, uint8 outcome, bytes32 salt)` | no | — | after commit deadline |
| `resolveDispute(uint256 id)` | no | `nonReentrant` | tally, round 0; **no money moves** — except a no-quorum round, which settles itself |
| `resolveAppeal(uint256 id)` | no | `nonReentrant` | tally + overturn penalty, round >= 1; same no-quorum settlement |
| `appeal(uint256 id)` | yes | `nonReentrant` | new round, fully random draw |
| `finalizeDispute(uint256 id)` | no | `nonReentrant` | permissionless; **payout executes here** |

### Rewards & fees

| Function | Payable | Guarded | Notes |
|---|---|---|---|
| `depositRewards()` | yes | — | funds `rewardPool`; drawn down per dispute |
| `withdrawFees()` | no | `onlyOwner`, `nonReentrant` | 50/50 treasury / sponsorship; odd wei to sponsorship |
| `sweepRewardPool()` | no | `onlyOwner`, `nonReentrant` | unspent `rewardPool` → treasury |

### Admin — all `onlyOwner`, timelocked in production

`setFeeBps(uint16)` (≤ `MAX_FEE_BPS = 500`),
`setDisputeFee(uint256)`,
`setArbiterRegistry(IArbiterRegistry)` (non-zero),
`setTreasury(address)` (non-zero),
`setSponsorshipWallet(address)` (non-zero),
`setTrustedForwarder(address)` (`address(0)` disables forwarding),
`_authorizeUpgrade` (UUPS).

### Views

| Function | Returns | Reverts |
|---|---|---|
| `milestoneStatus(uint256 id)` | `Status` | `UnknownMilestone` for `0` or `>= nextMilestoneId` |
| `getMilestone(uint256 id)` | `Milestone` struct | `UnknownMilestone` |
| `getDispute(uint256 id)` | `Dispute` struct | never — unknown ids return the zero struct |
| `getRound(uint256 id, uint8 round)` | 9-tuple (see below) | never |
| `computeCommit(uint256 id, uint8 round, uint8 outcome, bytes32 salt, address arbiter)` | `bytes32` | never |
| `claimable(uint256 id)` | `uint256` | — |
| `accruedFees()`, `rewardPool()`, `nextMilestoneId()` | `uint256` | — |
| `activeDisputes(address arbiter)` | `uint256` | — |
| `lockedBudget` / `reservedBudget` / `paidOutBudget` / `budgetLocker` | per `jobRef` | — |
| `feeBps`, `disputeFee`, `disputeReward`, `commitWindow`, `revealWindow`, `appealWindow`, `treasury`, `sponsorshipWallet`, `arbiterRegistry` | config | — |
| `MAX_FEE_BPS()`, `MAX_ARBITERS()`, `QUORUM()` | constants | — |

`getRound` returns `(address[3] arbiters, uint8 arbiterCount, uint8 commitCount,
uint8 revealCount, uint8[3] tally, uint64 commitDeadline, uint64 revealDeadline,
bool resolved, uint8 winningOutcome)`. Only indices `0..arbiterCount-1` of `arbiters`
are real; the rest are zero.

---

## Storage variables

| Variable | Type | Meaning |
|---|---|---|
| `arbiterRegistry` | `IArbiterRegistry` | eligibility + scoring trust boundary |
| `feeBps` | `uint16` | platform fee for **future** milestones; ≤ 500 |
| `disputeFee` | `uint256` | minimum ETH to open or appeal a dispute; **0 = free** |
| `disputeReward` | `uint256` | protocol-funded arbiter reward per dispute, drawn from `rewardPool`; 0 = no subsidy |
| `commitWindow` | `uint64` | commit-phase duration, seconds |
| `revealWindow` | `uint64` | reveal-phase duration, seconds |
| `appealWindow` | `uint64` | appeal window measured **from `revealDeadline`** |
| `treasury` | `address` | slashed collateral + undistributed fees + reward dust |
| `sponsorshipWallet` | `address` | receives 50% of every `withdrawFees` split |
| `milestones_` | `mapping(uint256 => Milestone)` | private; read via `getMilestone` |
| `disputes_` | `mapping(uint256 => Dispute)` | private; read via `getDispute` |
| `rounds_` | `mapping(uint256 => mapping(uint8 => Round))` | private; read via `getRound` |
| `activeDisputes` | `mapping(address => uint256)` | per-arbiter in-flight round count; the registry reads this for `_isBusy` |
| `nextMilestoneId` | `uint256` | next id; starts at 1 |
| `accruedFees` | `uint256` | unwithdrawn platform fees (solvency invariant) |
| `rewardPool` | `uint256` | subsidy balance: `depositRewards` + dust, drawn down per dispute |
| `claimable` | `mapping(uint256 => uint256)` | pull payouts: approved principal not yet withdrawn |
| `lockedBudget` | `mapping(bytes32 => uint256)` | wei locked at publish |
| `reservedBudget` | `mapping(bytes32 => uint256)` | wei drawn into unsettled milestones |
| `paidOutBudget` | `mapping(bytes32 => uint256)` | wei released by settlement / cancel / unlock |
| `budgetLocker` | `mapping(bytes32 => address)` | the client who locked the job |
| `_milestoneJob` | `mapping(uint256 => bytes32)` | milestoneId → jobRef; `bytes32(0)` = wallet-funded |
| `disputeReward` | `uint256` | protocol arbiter reward per dispute (see above); appended last, before `__gap` |
| `__gap` | `uint256[31]` | reserved storage; shrink only by slots added above |

Structs:

- `Milestone { bytes32 ref; address client; address freelancer; uint256 amount; uint16 feeBps; Status status; }`
- `Dispute { address openedBy; uint64 openedAt; uint256 fee; uint8 round; uint8 appealCount; address[3] settledArbiters; uint8 settledOutcome; }`
- `Round { address[3] arbiters; uint8 arbiterCount; mapping commits; mapping revealed; mapping votes; mapping stakeWeights; uint8 commitCount; uint8 revealCount; uint8[3] tally; uint64 commitDeadline; uint64 revealDeadline; bool resolved; uint8 winningOutcome; }`

`received` ETH is rejected (`"Escrow: direct transfers not allowed"`), so the contract
balance maps 1:1 to liabilities.

---

## Events

### Frozen — the indexer decodes these. Topic hashes are locked by `test/event-surface.ts`.

| Event | Signature | Topic hash |
|---|---|---|
| `MilestoneFunded` | `(uint256,bytes32,address,address,uint256)` | `0x6527340e…0ddf` |
| `MilestoneSubmitted` | `(uint256,address)` | `0x90143ae4…39a7` |
| `MilestoneReleased` | `(uint256,address,uint256,uint256,bool)` | `0x7891dccf…c966` |
| `DisputeResolved` | `(uint256,address,uint8)` | `0x0a1a08d0…c12a` |
| `TrustScoreUpdated` (registry) | `(address,int256,uint256,bool)` | `0x54807645…03c3` |
| `ArbiterRegistered` (registry) | `(address,uint256)` | `0xe4fa94e2…cab6` |

The last field of `MilestoneReleased` is `viaDisputeResolution`. `DisputeResolved`'s
`address` is the **caller that finalised**, not a party.

### Additive — escrow money and dispute

| Event | Emitted when |
|---|---|
| `MilestoneRefunded(uint256,address,uint256,bool)` | `cancel` (false) or a Refund ruling (true) |
| `MilestoneSplit(uint256,uint256,uint256,uint256)` | Split ruling: `clientAmount`, `freelancerAmount`, `fee` |
| `MilestoneCancelled(uint256,address,uint256)` | `cancel` |
| `FundsWithdrawn(uint256,address,uint256)` | `withdrawMilestone` |
| `FeeWithdrawn(address,uint256)` | `withdrawFees` — **twice per call**, one per leg |
| `BudgetLocked(bytes32,address,uint256)` / `BudgetUnlocked(bytes32,address,uint256)` | budget lock / unlock |
| `DisputeOpened(uint256,address,uint256)` | `openDispute` / `openDisputeWith` / `appeal` starts a round |
| `ArbitersSelected(uint256,uint8,address[3],uint8)` | round start, with the `stakeWeights` snapshot |
| `VoteCommitted` / `VoteRevealed` | per arbiter |
| `DisputeFinalized(uint256,uint8,uint8,uint8,bool)` | every tally, quorum or not |
| `ArbiterRewarded(uint256,address,uint256)` | a majority arbiter is paid (may be 2 per settlement: two pots) |
| `ArbiterPenalized(uint256,address,uint8)` | reason 2 minority, 3 missed, 4 overturned |
| `NoQuorumFallback(uint256,address,uint256)` | the round's threshold was not met: the opener's fee is refunded, the milestone is Refunded to the client, and **this log is the settlement receipt** (no `Milestone*` event is emitted on this path) |
| `AppealOpened(uint256,uint8,address,uint256)` | `appeal` |
| `AppealResolved(uint256,uint8,bool)` | `resolveAppeal`; `overturned` flag |
| `RewardsDeposited(address,uint256)` / `DisputeFeeUpdated(uint256,uint256)` | `depositRewards` / `setDisputeFee` |
| `RewardSubsidized(uint256,uint256)` | a settlement drew a subsidy out of `rewardPool` |
| `PlatformFeeUpdated(uint16,uint16)` / `SponsorshipWalletUpdated(address,address)` | admin setters |

`DisputeOpened` fires only on `openDispute` / `openDisputeWith`. An appeal emits
`AppealOpened` instead. Use `getDispute().appealCount` to tell rounds apart.

---

## Error decode

| Error | Meaning / fix |
|---|---|
| `ZeroAmount()` | value or amount was 0 |
| `ZeroAddress()` | a required address argument was 0 |
| `InvalidFreelancer()` | freelancer is `address(0)` or equals the client |
| `UnknownMilestone(id)` | id is 0 or not yet created |
| `NotClient()` / `NotFreelancer()` / `NotParty()` | caller is not the required party |
| `NotDisputable(status)` / `NotDisputed()` | wrong lifecycle state for a dispute call |
| `WrongStatus(expected, actual)` | compare against the decoded pair to build a UI message |
| `NothingToWithdraw()` | already withdrawn, or nothing accrued |
| `TransferFailed()` | the recipient rejected the ETH |
| `FeeTooHigh(requested, max)` | above the 5% cap |
| `BudgetAlreadyLocked(jobRef)` / `NoBudgetLocked(jobRef)` | lock the job first / wrong job |
| `InsufficientBudget(needed, available)` | draw or unlock exceeds the free balance |
| `BadBatch()` | empty batch or mismatched array lengths |
| `DisputeFeeTooLow(provided, required)` | attach at least `disputeFee` |
| `NotEnoughArbiters(eligible)` | zero arbiters could be drawn (always 0) |
| `WrongPhase(expected, actual)` | resolve the round before appealing |
| `NotSelectedArbiter()` | caller is not in `arbiters[0..count-1]` |
| `AlreadyCommitted()` / `AlreadyRevealed()` | already voted this round |
| `CommitDeadlinePassed()` / `CommitDeadlineNotPassed()` | wrong side of the commit window |
| `RevealWindowClosed()` / `RevealWindowOpen()` | wrong side of the reveal window / tally gate |
| `CommitMismatch()` | reveal does not match the committed hash |
| `NoneCommitted()` | declared but never emitted by the current code |
| `NotEnoughReveals(revealed, required)` | declared but never emitted by the current code |
| `InvalidOutcome(outcome)` | outcome > 2 |
| `ArbitrationAlreadyResolved()` | the round is tallied — see [Known behaviour](#known-behaviour) |
| `AppealWindowClosed()` / `AppealWindowOpen()` / `AppealAlreadyOpen()` | appeal phase misuse |
| `OwnableUnauthorizedAccount()` | owner-only call; route it through the timelock |

---

## Known behaviour

Verified against the code and by execution — documented so integrators are not surprised.

### The no-quorum fallback is a settlement, not a reset

Both no-quorum guards below are load-bearing and covered by regression tests in
`test/disputes.ts`.

**The fallback settles the milestone (`ResolvedRefund`), it does not return it to
`Submitted`.** It used to. That half-state was the bug: with the round `resolved` but
the milestone back in `Submitted`, the client could `approve` a payout no arbiter had
agreed to, while `finalizeDispute` and `appeal` on that same round reverted
`NotDisputed` — a UI offering both a payment and a "finalize" that could only revert.
The money now moves inside `resolveDispute` (the opener's fee and the whole milestone
back to the client), the status is terminal, and a disputed milestone can only be
settled by arbitration. `NoQuorumFallback` is the settlement receipt for this path:
there is no `finalizeDispute` tx to emit a `Milestone*` event from, so the backend
mirrors the status and `settlementTxHash` off that one log.

**Round slots are never reused, so they need no reset (was: a re-opened round was
permanently stuck).** While the fallback returned the milestone to `Submitted`, a party
could re-open the dispute and `_startRound` wrote the new selection into the round slot
without clearing the old vote state, so the dispute reused a `resolved` round and every
exit path reverted (`commitVote`, `resolveDispute`, `approve`, `cancel` all failed) — the
milestone's ETH was stuck. `_resetRound` used to fix that by wiping the slot. The
fallback now settles, so round 0 is written exactly once per dispute and an appeal always
targets a fresh `round + 1` index; `_resetRound` is gone with the state it guarded.
**If a future upgrade ever lets a settled milestone be disputed again, it must wipe the
slot first** — Solidity rejects `delete` on a struct with mapping members, so the
per-arbiter `commits` / `revealed` / `votes` / `stakeWeights` mappings need the explicit
per-address `delete` loop that `_resetRound` used.

**`appeal` requires `Disputed` (was: a no-quorum appeal stranded the fee).** The
fallback never restores `Disputed`, so an appeal opened on top of that round could never
be tallied or finalized — `resolveAppeal` and `finalizeDispute` both require `Disputed` —
yet the appeal fee was accepted and stranded. `appeal` now reverts `NotDisputed`.

### Open

**The overturn penalty hits every selected arbiter, not only the majority.**
`_tally` stores `d.settledArbiters = r.arbiters` — the whole selected array. When
`resolveAppeal` sees a changed outcome it applies `−25` to every non-zero address in
that array that is still registered, including the arbiters who voted with the
now-overturned majority *and* any non-revealers.

**`TrustScoreUpdated`'s 4th field is not what it is named.** It is declared
`bool withinSla` but emitted as `delta >= 0`. Read it as "was this a positive delta".
The topic hash is frozen, so this is documented rather than changed.

**`getDispute` does not revert for unknown ids.** It returns a zero struct; check
`openedAt != 0` to detect a real dispute.

**`NoneCommitted` and `NotEnoughReveals` are declared but never emitted.**

**The production timelock topology has no test coverage.** `test/fixtures.ts`
exports `deployWithTimelockOwner()` and `viaTimelock()`, but no test imports them, and
`deployWithTimelockOwner` passes 9 arguments to the 10-parameter
`Escrow.initialize` (it omits `sponsorshipWallet`). Every test runs against
`deployWithEoaOwner()`, where the EOA owns the proxies directly.
