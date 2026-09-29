# OpenLance contracts — reference

Integration reference for the `contracts/` package. Written against the source and the
84-test suite; every call sequence below is one the tests actually execute.

**Audience:** backend / frontend / agents integrating against these contracts. For the
security posture, threat model and Slither disposition, read [`../SECURITY.md`](../SECURITY.md).

| Doc | Covers |
|---|---|
| [`escrow.md`](./escrow.md) | `Escrow` — budget drawdown, milestone lifecycle, dispute engine, fee routing, all storage/events/errors |
| [`arbiter-registry.md`](./arbiter-registry.md) | `ArbiterRegistry` — staking, trust score, soulbound badge, tiers, the escrow-only trust boundary |
| [`sponsorship.md`](./sponsorship.md) | `SponsorshipForwarder` + `ERC2771ContextLite` — gasless ERC-2771 relay, EIP-712 sessions |

Start with the flow section at the top of `escrow.md`; each doc leads with call
sequences and puts the lookup tables underneath.

---

## Topology

```
              ┌──────────────────────────────────────┐
              │  OpenLanceTimelock  (sole owner)     │  OZ TimelockController
              │  minDelay 48h in production          │  public warning window
              └──────────────────┬───────────────────┘
                                 │ upgrade authority
        ┌────────────────────────┴────────────────────────┐
        ▼                                                 ▼
┌───────────────────┐   reads eligibility/scoring    ┌──────────────────────────┐
│  Escrow (UUPS)    │────────────────────────────────►│  ArbiterRegistry (UUPS)  │
│  ERC1967 proxy    │◄────────────────────────────────│  ERC1967 proxy           │
│                   │   applyScoreChange / stakeOf    │  ERC721 + ERC-5194      │
└───────────────────┘                                 └──────────────────────────┘
        ▲
        │ trustedForwarder (ERC-2771)
┌───────────────────┐
│SponsorshipForwarder│  not upgradeable; holds no funds
└───────────────────┘
```

Deployment order: timelock → forwarder → registry proxy → escrow proxy →
`registry.setEscrow(escrow)` through the timelock.

Both implementations pass the OpenZeppelin upgrade-safety validator. `Escrow` is
`Ownable2Step`; both constructors call `_disableInitializers()` to block implementation
squatting.

---

## The frozen indexer contract

`src/server/chain/abi.ts` and `src/lib/contracts.ts` mirror this ABI by hand.
`test/event-surface.ts` locks the six topic hashes and the `Status` / `Outcome` ordinals,
so drift fails the build.

If you change an event signature, an enum order, or the frozen read surface, update
`abi.ts` **and** `contracts.ts` in the same change.

| Event | Contract | Signature | Topic hash |
|---|---|---|---|
| `MilestoneFunded` | Escrow | `(uint256,bytes32,address,address,uint256)` | `0x6527340e…0ddf` |
| `MilestoneSubmitted` | Escrow | `(uint256,address)` | `0x90143ae4…39a7` |
| `MilestoneReleased` | Escrow | `(uint256,address,uint256,uint256,bool)` | `0x7891dccf…c966` |
| `DisputeResolved` | Escrow | `(uint256,address,uint8)` | `0x0a1a08d0…c12a` |
| `TrustScoreUpdated` | Registry | `(address,int256,uint256,bool)` | `0x54807645…03c3` |
| `ArbiterRegistered` | Registry | `(address,uint256)` | `0xe4fa94e2…cab6` |

`Status` ordinals and `Outcome` ordinals are in [`escrow.md`](./escrow.md#status-enum-frozen--the-indexer-maps-uint8--name).

---

## Money invariants

1. **Solvency** — `balance >= Σ unsettled milestone amounts + accruedFees`. A locked
   budget is liability-backed the moment `lockBudget` lands.
2. **Settle once** — a milestone settles at most once; terminal states are final.
3. **Per-job budget** — `reservedBudget + paidOutBudget <= lockedBudget`; the free
   balance backs nothing already promised.
4. **No free transfers** — direct ETH transfers to either money contract revert, so the
   balance maps 1:1 to liabilities.
5. **No conflicted arbiters** — a dispute never selects a party to that milestone.
6. **Reentrancy** — `ReentrancyGuardTransient` (EIP-1153) plus checks-effects-interactions
   on every payout path.

---

## Deploy-time defaults

From `scripts/deploy.ts`. Every value is an env override; local defaults are short so the
time-based rules are observable without warping days of chain time.

| Parameter | Env var | Local | Public network |
|---|---|---|---|
| Platform fee | `INITIAL_FEE_BPS` | 250 (2.5%) | 250 |
| Timelock delay | `TIMELOCK_DELAY` | 60s | 172800s (48h) |
| Min arbiter stake | `MIN_STAKE_WEI` | 0.1 ETH | 0.1 ETH |
| Min score to withdraw | `MIN_SCORE_TO_WITHDRAW` | 50 | 50 |
| Min stake duration | `MIN_STAKE_DURATION_SECONDS` | 60s | 604800s (7d) |
| Unstake cooldown | `UNSTAKE_COOLDOWN_SECONDS` | 60s | 259200s (3d) |
| Dispute fee | `DISPUTE_FEE_WEI` | 0 (free) | 0 (free) |
| Arbiter reward per dispute | `DISPUTE_REWARD_WEI` | 0.05 ETH | 0.05 ETH (from `rewardPool`) |
| Commit window | `COMMIT_WINDOW_SECONDS` | 120s | 86400s (24h) |
| Reveal window | `REVEAL_WINDOW_SECONDS` | 120s | 86400s (24h) |
| Appeal window | `APPEAL_WINDOW_SECONDS` | 600s | 172800s (48h) |
| Treasury | `TREASURY` | deployer | `FINAL_ADMIN` |
| Sponsorship wallet | `SPONSORSHIP_WALLET` | treasury | treasury |
| Final admin | `FINAL_ADMIN` | deployer | deployer — use a Safe in production |

Test fixtures use the same values except a 1h `minStakeDuration` and a 30m
`unstakeCooldown` (`test/fixtures.ts`).

Tier floors derive from `minStake`: silver = 10×, gold = 100×.

---

## Build and test

```
npx hardhat build                                  # optimizer on, 200 runs, cancun
npx hardhat build --build-profile production       # optimizer on, 800 runs
npx hardhat test                                   # 84 tests
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/deploy.ts --network baseSepolia
npx hardhat run scripts/export-abi.ts               # emit ABI JSON for the backend
```

Solidity 0.8.28, Hardhat 3 (TypeScript + viem), OpenZeppelin 5.x, `evmVersion = cancun`.
Test profiles: fuzz 256 runs, invariant 128 runs × depth 128.

The suite is the ground truth for every sequence in these docs: `escrow.ts`,
`drawdown.ts`, `disputes.ts` + `disputeFlow.ts`, `registry.ts`, `sponsorship.ts`,
`eip712-agreement.ts`, `reentrancy.ts`, `upgrade.ts`, `event-surface.ts`.

---

## Known gaps

Documented in full in each doc's *Known behaviour* section.

**Fixed** (found while writing these docs, each with regression tests):

- Round slots are now reset on reuse — a dispute re-opened after a no-quorum fallback
  used to reuse a `resolved` round and be permanently stuck.
- `appeal` now rejects a milestone the no-quorum fallback already returned to
  `Submitted`; its fee used to be accepted and stranded.
- `rewardPool` now funds arbiter rewards: each settlement draws
  `min(rewardPool, d.fee)` into the pot, so the protocol matches the opener's fee,
  capped at 1× it. `RewardSubsidized` reports the draw.
- The production timelock topology is now covered by `test/upgrade.ts`, and
  `deployWithTimelockOwner` no longer misaligns `Escrow.initialize` (it was passing 9
  arguments to a 10-parameter function).

**Open:**

- The overturn penalty applies to every selected arbiter, not only the majority.
- Arbiter selection uses `prevrandao`; see `SECURITY.md` for the bounded exposure and
  the VRF migration path.

**Test coverage note:** the money and dispute suites run with an EOA owner
(`deployWithEoaOwner`) so owner-only calls are reachable. The timelock topology has its
own describe block in `test/upgrade.ts`.
