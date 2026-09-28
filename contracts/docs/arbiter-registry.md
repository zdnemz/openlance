# ArbiterRegistry — integration reference

Source: `contracts/ArbiterRegistry.sol` (UUPS upgradeable, ERC-721 + ERC-5194,
owner = `OpenLanceTimelock`).

Everything about *who may arbitrate* lives here. The `Escrow` owns the dispute
lifecycle and calls back into this contract to score and slash arbiters.

Sequences below are executed by `test/registry.ts`.

---

## Trust boundary — what the Escrow may call

Only the escrow address (`escrow`, set once via `setEscrow`) can move scores or stake.
The Escrow's actual call surface is narrow:

| Function | Called by the Escrow? |
|---|---|
| `applyScoreChange(address, int256, uint8)` | **yes** — every settlement, every appeal overturn |
| `isEligible(address)` | **yes** — during arbiter selection |
| `stakeOf(address)` | **yes** — snapshots the reward weight at selection |
| `isRegistered(address)` | **yes** — guards scoring loops |
| `rosterLength()` / `rosterAt(uint256)` | **yes** — the random draw |
| `slash(address)` | **no** — `onlyEscrow`, but the Escrow never calls it |
| `slashStake(address)` | **no** — same |

`slash` and `slashStake` appear in the ABI but are **unreachable from the current
Escrow implementation**. The old README documented a `slashStaleArbiter` SLA feature
that does not exist: a missed-deadline arbiter takes the `−15` trust penalty and
nothing else — no removal, no collateral slash. Treat both functions as a prepared
extension point, not a live capability, and never expose them as user-facing actions.

`escrow` is **one-shot**: `setEscrow` reverts `EscrowAlreadySet` if already set, so the
owner can never repoint scoring at a malicious contract. There is no `setEscrow` reset
and no upgrade path that changes this without a full proxy upgrade.

`escrow.activeDisputes(arbiter)` is read back through a guarded `staticcall` to
implement `_isBusy`; a missing or broken escrow fails **open** (treated as idle) so a
registry-only deployment cannot brick unstaking.

---

## Flow 1 — join

```
registerArbiter{value: >= minStake}()   → tokenId
```

Self-registration. Mints a soulbound ERC-5194 badge and sets `trustScore = 100`.
Reverts `StakeBelowMinimum` below the floor and `AlreadyRegistered` on a double join.

```
register(address arbiter){value: >= minStake}()   → tokenId   ← onlyOwner
```

Platform-vetted entry; also payable so the platform can seed an arbiter's stake in the
same transaction. Same validation.

**Timing gate:** a new arbiter is *not* eligible for selection until
`block.timestamp >= stakedAt + minStakeDuration`. Check `eligibleAt(arbiter)` and show
a countdown rather than letting the user discover the failure.

**Re-registration keeps history.** A returning wallet reuses its original SBT
`tokenId`, and `trustScore` and `resolutions` are **permanent** — a wallet that once hit
0 keeps score 0 and is permanently ineligible, even after re-staking. There is no score
recovery function on-chain.

## Flow 2 — resize the position

```
addStake{value: delta}()          top up, stays on the roster
reduceStake(uint256 amount)       partial exit, stays registered
```

`reduceStake` reverts `FullExitRequired` if `amount >= stake` (emptying requires the full
exit flow) and `RemainingBelowMinimum` if the remainder would drop below `minStake`.
Same health gates as the exit: idle, score at/above the floor, stake aged
`unstakeCooldown`. Tier follows the stake down automatically.

## Flow 3 — full exit

```
requestUnstake()      → benched immediately, no ETH moves
cancelUnstake()       → optional, rejoins the selection pool
withdrawStake()       → pays out at once
```

`requestUnstake` signals intent and benches the arbiter from selection instantly
(`isEligible` returns false as soon as the flag is set), so the escrow will not draw
them for a new dispute. It reverts:

- `StakeIsLocked(score, minScore)` when `trustScore < minScoreToWithdraw`
- `UnstakeTooEarly(readyAt)` before `stakedAt + unstakeCooldown`
- `StillHandlingDispute(arbiter)` while `escrow.activeDisputes[arbiter] > 0`
- `UnstakeAlreadyRequested`, `NoStake`

`withdrawStake` pays out **immediately** once requested — the only wait is the
pre-request aging, so there is no second cooldown. It zeroes the stake, clears both
unstake flags, sets `registered = false`, removes the arbiter from the roster, and
leaves the SBT as a permanent record. The badge is never burned.

`cancelUnstake` only clears the request; it needs no other gate.

> The cooldown gates the **request**, not the payout. This differs from a naive reading
> of `unstakeReadyAt`, which returns `unstakeRequestedAt + unstakeCooldown` — that value
> is a record only and is **not** enforced by `withdrawStake`.

---

## Trust score

`MAX_SCORE = 100`; a new arbiter starts at the cap. Scores are clamped to `[0, 100]`
and every mutation increments `resolutions`.

| Delta | Reason const | Value | Applied when |
|---|---|---|---|
| `DELTA_MAJORITY` | `REASON_MAJORITY = 1` | `+5` | voted with the winning majority |
| `DELTA_MINORITY` | `REASON_MINORITY = 2` | `−10` | revealed against the majority |
| `DELTA_MISSED` | `REASON_MISSED = 3` | `−15` | never revealed |
| `DELTA_OVERTURNED` | `REASON_OVERTURNED = 4` | `−25` | decision overturned on appeal |
| `REASON_RECOVERY = 5` | — | — | reserved, never emitted |

Threshold behaviour:

- `trustScore < minScoreToWithdraw` → stake **locked** (`requestUnstake`,
  `reduceStake` and `withdrawStake` all revert `StakeIsLocked`) and the arbiter is
  **benched** from selection.
- `trustScore == 0` → the full stake is **slashed to the treasury** and the arbiter is
  removed from the roster. This is permanent; there is no re-entry at a positive score.

`applyScoreChange` emits `ScoreChanged(arbiter, old, new, reason)` on every mutation and
the legacy `TrustScoreUpdated(arbiter, delta, new, delta >= 0)`. The 4th field of
`TrustScoreUpdated` is declared `withinSla` but is really `delta >= 0` — read it as
"was this a positive delta". Its topic hash is frozen by `test/event-surface.ts`, so it
is documented rather than renamed.

---

## Stake tiers

`tierOf` is a **pure stake read** — selection weight already scales with `stakeOf`, so
the tier is display metadata.

| `tierOf` | Name | Default threshold |
|---|---|---|
| 0 | none | unregistered or below `minStake` |
| 1 | bronze | `>= minStake` (0.1 ETH default) |
| 2 | silver | `>= tierSilver` (10× `minStake`, 1 ETH) |
| 3 | gold | `>= tierGold` (100× `minStake`, 10 ETH) |

`setMinStake` raises `tierSilver` / `tierGold` when they would fall below the new floor.
`setTierThresholds` validates `minStake <= silver <= gold` and otherwise reverts
`BadTierThresholds`.

---

## Function reference

### Public

| Function | Payable | Guarded | Notes |
|---|---|---|---|
| `registerArbiter()` | yes | — | `>= minStake`; score 100, mints badge |
| `register(address)` | yes | `onlyOwner` | platform-vetted; may seed stake |
| `addStake()` | yes | — | top up |
| `reduceStake(uint256 amount)` | no | `nonReentrant` | partial exit, stays registered |
| `requestUnstake()` | no | — | benches immediately |
| `cancelUnstake()` | no | — | clears the request |
| `withdrawStake()` | no | `nonReentrant` | immediate payout + deregistration |

ERC-721 `transfer` / `safeTransferFrom` are inherited and revert `NonTransferable`;
the badge is soulbound. The ERC-5194 `Unlocked` event is declared but never emitted.

### Escrow-only

| Function | Notes |
|---|---|
| `applyScoreChange(address, int256, uint8)` | bounds the score, slashes at 0, locks below the floor |
| `slash(address)` | deregisters without touching the stake — **never called by the Escrow** |
| `slashStake(address)` | full collateral slash — **never called by the Escrow** |

### Admin — all `onlyOwner`, timelocked in production

`setEscrow(address)` (one-shot), `setMinStake`, `setTierThresholds(silver, gold)`,
`setMinScoreToWithdraw` (≤ `MAX_SCORE`), `setMinStakeDuration`, `setUnstakeCooldown`,
`setTreasury`, `setTrustedForwarder(address)`, `_authorizeUpgrade` (UUPS).

### Views

| Function | Returns |
|---|---|
| `isRegistered(address)` | on the roster at all |
| `isEligible(address)` | the **selection gate**: registered ∧ not mid-unstake ∧ score ≥ floor ∧ stake ≥ minStake ∧ `stakedAt + minStakeDuration` reached |
| `trustScoreOf(address)` | `0–100` |
| `stakeOf(address)` | wei collateral |
| `tierOf(address)` | `0–3` |
| `isLocked(address)` | registered ∧ score below the withdrawal floor |
| `resolutionsOf(address)` | scored events, penalties included |
| `arbiterInfo(address)` | full `ArbiterInfo` struct |
| `eligibleAt(address)` | unix time the arbiter first becomes selectable |
| `unstakeReadyAt(address)` | `unstakeRequestedAt + unstakeCooldown`; `0` if no request. **Record only** |
| `rosterLength()` / `rosterAt(uint256)` | the enumerable candidate set |
| `rosterSnapshot()` | whole roster — bounded use only, prefer length + at |
| `locked(uint256 tokenId)` | ERC-5194; true while the badge exists |
| `trustedForwarder(address?)` / `isTrustedForwarder(address)` | ERC-2771 plumbing |
| `escrow`, `minStake`, `minScoreToWithdraw`, `treasury`, `minStakeDuration`, `unstakeCooldown`, `tierSilver`, `tierGold`, `nextTokenId` | config |
| `MAX_SCORE`, `DELTA_*`, `REASON_*` | constants |

Roster removal is O(1) swap-remove: an arbiter removed from the middle is replaced by the
last element, so **roster indices are not stable** across churn. Cache by address, not
by index.

---

## Storage variables

| Variable | Type | Meaning |
|---|---|---|
| `escrow` | `address` | the only caller allowed to score/slash; set once |
| `nextTokenId` | `uint256` | SBT id counter, starts at 1 |
| `arbiters` | `mapping(address => ArbiterInfo)` | internal; read via `arbiterInfo` |
| `roster` | `address[]` | internal enumerable roster |
| `rosterIndex` | `mapping(address => uint256)` | 1-based index into `roster`; `0` = absent |
| `minStake` | `uint256` | minimum collateral to join or stay |
| `minScoreToWithdraw` | `uint256` | score below which the stake locks and the arbiter is benched |
| `treasury` | `address` | receives slashed collateral |
| `minStakeDuration` | `uint256` | continuous stake time before an arbiter may be **selected** |
| `unstakeCooldown` | `uint256` | stake age before `requestUnstake` may be called |
| `tierSilver` / `tierGold` | `uint256` | tier floors; `minStake <= silver <= gold` |
| `__gap` | `uint256[35]` | reserved storage; shrink only by slots added above |

`ArbiterInfo { bool registered; bool unstakeRequested; uint256 tokenId; uint256 trustScore;
uint256 stake; uint256 resolutions; uint256 stakedAt; uint256 unstakeRequestedAt; }`

`stakedAt` starts the `minStakeDuration` clock and is set only on first enrolment.
`addStake` and `reduceStake` do not reset it, so topping up does not re-lock selection.

Direct ETH transfers are rejected (`"ArbiterRegistry: direct transfers not allowed"`);
collateral only enters through the staking API.

---

## Events

### Frozen — the indexer decodes these

| Event | Signature | Topic hash |
|---|---|---|
| `ArbiterRegistered` | `(address,uint256)` | `0xe4fa94e2…cab6` |
| `TrustScoreUpdated` | `(address,int256,uint256,bool)` | `0x54807645…03c3` |
| `ArbiterDeregistered` | `(address)` | additive |
| `ScoreChanged` | `(address,uint256,uint256,uint8)` | additive |

### Staking and admin

`StakeDeposited(arbiter, amount, totalStake)` (also emitted on enrolment),
`StakeReduced(arbiter, amount, remaining)`, `StakeLocked(arbiter, amount, score)`,
`UnstakeRequested(arbiter, amount)`, `UnstakeCancelled(arbiter)`,
`StakeWithdrawn(arbiter, amount)`, `StakeSlashed(arbiter, treasury, amount)`,
`EscrowSet(escrow)`, `TreasuryUpdated`, `MinStakeUpdated`, `TierThresholdsUpdated`,
`MinScoreToWithdrawUpdated`, `MinStakeDurationUpdated`, `UnstakeCooldownUpdated`,
`Locked(tokenId)`, `TrustedForwarderSet(forwarder)`.

`StakeLocked` is emitted immediately before a `StakeIsLocked` revert, so a revert rolls
the log back — read eligibility from `isLocked` / `isEligible` rather than from logs.

---

## Error decode

| Error | Meaning / fix |
|---|---|
| `ZeroAddress()` | a required address was 0 |
| `NotRegistered(arbiter)` / `AlreadyRegistered(arbiter)` | join state |
| `NotEscrow()` / `NotAuthorized()` | escrow-only or owner-only call |
| `EscrowAlreadySet(current)` | `setEscrow` is one-shot |
| `StakeBelowMinimum(provided, minStake)` | attach at least `minStake` |
| `AlreadyStaked(currentStake)` | declared, never emitted by the current code |
| `NoStake()` | zero stake, or nothing to withdraw |
| `StakeIsLocked(score, minScore)` | score below the withdrawal floor; wait for recovery |
| `UnstakeNotRequested()` / `UnstakeAlreadyRequested()` | call `requestUnstake` / `cancelUnstake` first |
| `StillHandlingDispute(arbiter)` | `escrow.activeDisputes > 0`; finish the round first |
| `FullExitRequired()` | `reduceStake` cannot empty the account |
| `RemainingBelowMinimum(remaining, minStake)` | the remainder would drop below the floor |
| `UnstakeTooEarly(readyAt)` / `UnstakeCooldownActive(readyAt)` | stake has not aged `unstakeCooldown` |
| `StakeTooRecent(stakedAt, minStakeDuration)` | declared, never emitted by the current code |
| `BadTierThresholds(silver, gold, minStake)` | violates `minStake <= silver <= gold` |
| `ScoreOutOfRange(score)` | above `MAX_SCORE` |
| `NonTransferable(tokenId)` | the badge is soulbound |
| `TransferFailed()` | the recipient rejected the ETH |
| `OwnableUnauthorizedAccount()` | owner-only call; route it through the timelock |

---

## Known behaviour

**1. `slash` and `slashStake` are unreachable.** Both are `onlyEscrow` and the Escrow
calls neither. The only live slashing path is the automatic `_slash` inside
`applyScoreChange` when a score reaches 0.

**2. Score 0 is a life sentence.** `_boundedScore` clamps at 0, `_slash` moves the whole
stake to the treasury, and re-enrolling preserves the score. There is no `REASON_RECOVERY`
path on-chain; recovery from 0 is not possible.

**3. `unstakeReadyAt` is not an enforced gate.** It returns
`unstakeRequestedAt + unstakeCooldown`, but `withdrawStake` never reads it — the real gate
was applied earlier, in `requestUnstake`. Do not use it to predict payout availability.

**4. The cooldown never resets on top-up.** `stakedAt` is set once at enrolment, so
`addStake` cannot restart the clock and cannot re-lock an eligible arbiter.

**5. Roster indices are unstable.** Swap-remove moves the last element into the freed
slot. Never persist a roster index across a removal.
