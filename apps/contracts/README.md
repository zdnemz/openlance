# OpenLance — Contracts

The on-chain money authority of OpenLance: **one escrow contract** holding every
milestone. Dispute, arbiter, fee and settlement logic is cross-project, and a single
accounting surface is what the invariant tests protect.

**Stack:** Solidity 0.8.28 · Hardhat 3 (TypeScript + viem) · OpenZeppelin Contracts +
Contracts-Upgradeable 5.x · **UUPS upgradeable proxies** owned by an OZ
`TimelockController` · native ETH.

> This directory replaces the earlier Foundry setup. The public interface (events,
> status enum ordinals, read surface) is preserved so the backend indexer
> (`src/server/chain/abi.ts`) keeps working unchanged.

```
npm install
npx hardhat build                 # compile
npx hardhat test                  # 84 tests
npx hardhat run scripts/deploy.ts --network localhost     # anvil devnet
npx hardhat run scripts/deploy.ts --network baseSepolia   # testnet
```

---

## 📖 Documentation

**→ [`docs/`](./docs/README.md) is the reference.** Start there.

| Doc | Covers |
|---|---|
| [`docs/escrow.md`](./docs/escrow.md) | `Escrow` — budget drawdown, milestone lifecycle, dispute engine, fee routing, storage / events / errors |
| [`docs/arbiter-registry.md`](./docs/arbiter-registry.md) | `ArbiterRegistry` — staking, trust score, soulbound badge, tiers, escrow-only trust boundary |
| [`docs/sponsorship.md`](./docs/sponsorship.md) | `SponsorshipForwarder` + `ERC2771ContextLite` — gasless ERC-2771 relay, EIP-712 sessions |
| [`SECURITY.md`](./SECURITY.md) | review, findings disposition, invariants, known simplifications |

This file is orientation only. Anything authoritative about how to *call* something
lives in `docs/`, and each doc carries its own *Known behaviour* section listing places
where the code differs from what you would expect.

---

## Architecture

```
              ┌──────────────────────────────┐
              │  OpenLanceTimelock (owner)    │  OZ TimelockController
              │  minDelay = 48h in prod       │  48h public window before
              └──────────────┬───────────────┘  any upgrade / owner call
                             │ owns (upgrade authority)
        ┌────────────────────┴────────────────────┐
        ▼                                          ▼
┌───────────────────┐    reads     ┌──────────────────────────┐
│  Escrow (UUPS)    │─────────────►│  ArbiterRegistry (UUPS)   │
│  ERC1967 proxy    │              │  ERC1967 proxy            │
│  + Escrow impl    │              │  + ArbiterRegistry impl   │
└───────────────────┘              └──────────────────────────┘
        ▲
        │ trustedForwarder (ERC-2771, gasless)
┌───────────────────┐
│SponsorshipForwarder│  not upgradeable; holds no funds
└───────────────────┘
```

Every upgrade and owner-only action is routed through the timelock, so users get a
public warning window before the money logic can change.

## Contracts

| File | Role |
|---|---|
| `contracts/Escrow.sol` | milestone state machine, job-budget drawdown, multi-arbiter dispute engine, fee routing |
| `contracts/ArbiterRegistry.sol` | ETH-collateralised roster, 0–100 trust score, soulbound ERC-5194 badge, stake tiers |
| `contracts/IArbiterRegistry.sol` | the surface `Escrow` depends on — its explicit trust boundary |
| `contracts/SponsorshipForwarder.sol` | ERC-2771 gasless meta-tx forwarder + EIP-712 sponsorship sessions |
| `contracts/ERC2771ContextLite.sol` | ERC-2771 `_msgSender` support for UUPS proxies (storage-based forwarder) |
| `contracts/OpenLanceTimelock.sol` | OZ `TimelockController`, owner of both proxies |

### `Escrow` in one paragraph

A client locks a job's full budget once at `lockBudget`, then each milestone is funded
from that locked balance via `fundAllFromCredit` / `fundFromCredit` — one wallet
round, not one per milestone. A milestone then runs `submit` → `approve` →
`withdrawMilestone`, where `approve` accrues the fee and makes the principal *claimable*
and the freelancer pulls it. Or either party opens a dispute, up to three eligible
non-party arbiters are drawn, and a commit–reveal vote decides; 2-of-3 quorum, with a
no-quorum fallback and an appeal window before `finalizeDispute` moves the money.

### `ArbiterRegistry` in one paragraph

`registerArbiter` joins the roster with locked ETH collateral and a soulbound badge at
score 100. Trust moves `+5` majority / `−10` minority / `−15` missed / `−25` overturned,
applied only by the escrow. Score below `minScoreToWithdraw` locks the stake and benches
the arbiter; score 0 slashes the whole collateral to the treasury. A time-based
`minStakeDuration` gates selection and `unstakeCooldown` gates the unstake request, which
blocks join-and-leave sniping.

## Layout

```
contracts/            Solidity sources (see table above)
docs/                 integration reference — start here
test/                 TypeScript + viem test suite (84 tests)
  fixtures.ts           shared deploy helpers + test params
  disputeFlow.ts        commit/reveal/deadline/finalize helpers
  event-surface.ts      locks indexer topic hashes + enum ordinals
  escrow.ts             lifecycle, fee accounting, access control
  drawdown.ts           lockBudget → fundFromCredit → unlockBudget
  disputes.ts           selection, commit-reveal, quorum, appeal, rewards
  registry.ts           staking, scoring, tiers, lock/slash
  sponsorship.ts        gasless relay + replay/session rejection
  eip712-agreement.ts   client digest == contract digest
  reentrancy.ts         reentrancy + solvency accounting
  upgrade.ts            UUPS authorization + storage survival
  test/ReentrancyAttacker.sol  test-only probe
scripts/
  deploy.ts           timelock + forwarder + both proxies + wiring (Base Sepolia / localhost)
  execute-timelock.ts execute a queued timelock op
  handoff-timelock.ts hand control to a Safe multisig
  export-abi.ts       emit ABI JSON the backend can import
  verify.ts           source verification on Etherscan
hardhat.config.ts     networks, solc profiles, fuzz/invariant profiles
SECURITY.md           review, findings disposition, invariants
slither.config.json   static-analysis config
```

## The interface contract with the backend

The backend indexer (`src/server/chain/abi.ts`) decodes the **frozen money events** plus
the dispute and registry events. `test/event-surface.ts` locks every frozen topic hash and
both enum ordinals, so a Solidity rename that would break the indexer fails the build
instead of production. Full table in [`docs/README.md`](./docs/README.md#the-frozen-indexer-contract).

## Security

See [`SECURITY.md`](./SECURITY.md). Summary:

- **0 High / 0 Medium** Slither findings on the production contracts.
- Both implementations pass the OpenZeppelin upgrade-safety validator.
- Tests cover UUPS authorization, implementation squatting, storage survival,
  reentrancy, solvency, wei-exact conservation, soulbound enforcement, one-shot wiring,
  direct-transfer rejection, fee snapshots, staking, stake locking, score
  penalties/rewards, quorum, the no-quorum fallback, and stake slashing.

## Known gaps

Writing the docs turned up four real defects, all **fixed** with regression tests:

- A dispute re-opened after a no-quorum fallback reused a `resolved` round and was
  permanently stuck. Round slots are now reset on reuse.
- `appeal` accepted (and stranded the fee of) a milestone the no-quorum fallback had
  already returned to `Submitted`. It now reverts `NotDisputed`.
- `rewardPool` accepted deposits but never paid out. It now subsidises each dispute's
  reward pot by `min(rewardPool, d.fee)` — the protocol matches the opener's fee, capped
  at 1× it.
- The production timelock topology had no test coverage, and its fixture misaligned
  `Escrow.initialize`. Both fixed.

One remains open: the overturn penalty applies to every selected arbiter, not only the
majority. Full detail in [`docs/escrow.md`](./docs/escrow.md#known-behaviour).
