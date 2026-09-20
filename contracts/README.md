# OpenLance — Contracts

The on-chain money authority of OpenLance: **one escrow contract** holding every
milestone (dispute, arbiter, fee and settlement logic is cross-project and a
single accounting surface is what the invariant tests protect).

**Stack:** Solidity 0.8.28 · **Hardhat 3** (TypeScript + viem) · OpenZeppelin
Contracts + Contracts-Upgradeable 5.6.1 · **UUPS upgradeable proxies** owned by an
OZ **TimelockController** · native ETH.

> This directory replaces the earlier Foundry setup. The public interface
> (events, status enum ordinals, read surface) is preserved byte-for-byte so the
> backend indexer (`src/server/chain/abi.ts`) keeps working unchanged.

```
npm install
npx hardhat build                 # compile
npx hardhat test                  # 72 tests (unit + security + event-surface + sponsorship)
npx hardhat run scripts/deploy.ts --network localhost      # anvil devnet
npx hardhat run scripts/deploy.ts --network baseSepolia    # testnet
```

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
```

Every upgrade and owner-only action is routed through the timelock, so users get
a public warning window before the money logic can change.

### `Escrow.sol` — milestone state machine + money

```
                                          ┌── approve ──> Released (fee taken)
               fund        submit         │
(off-chain) ──> Funded ──> Submitted ─────┤
               │      │                   │
               │      └─ dispute ─> Disputed ─ resolve ─> ResolvedRelease / Refund / Split
               └─ cancel ─> Cancelled           │
                                                 └─ slashStaleArbiter (after SLA+grace):
                                                    arbiter removed, dispute reassignable
```

- **UUPS upgradeable** (`initialize` is atomic and one-shot; `_disableInitializers()`
  in the constructor blocks implementation squatting).
- **`Ownable2Step`** — ownership transfers require the new owner to accept, so a
  typo'd timelock/admin address cannot silently brick the contract.
- **`ReentrancyGuardTransient`** (EIP-1153) + CEI on every payout path.
- **Fee snapshot per milestone** (funding-time `feeBps`, hard-capped at 5%).
- **`ref` join key** — the off-chain milestone uuid travels in `fund(ref, …)`.

### `ArbiterRegistry.sol` — staked identity + soulbound badge + trust

- **ETH-collateralised roster.** `registerArbiter() {value: >= minStake}` joins
  with a locked ERC-5194 soulbound badge. `requestUnstake()` / `withdrawStake()`
  return the collateral only when the arbiter is idle and healthy.
- **Trust score (0–100).** New arbiters start at 100. `+5` majority, `−10`
  minority, `−15` missed deadline, `−25` overturned — applied only by the escrow
  via `applyScoreChange`. `ScoreChanged(arbiter, old, new, reason)` fires on every
  mutation.
- **Score < n (minScoreToWithdraw) → stake LOCKED** and the arbiter is benched
  from selection until the score recovers.
- **Score = 0 → full slash to the treasury** and removal from the roster.
- Enumerable roster (`rosterLength`/`rosterAt`) so the escrow can draw candidates
  on-chain; `isEligible(a)` is the selection gate.

### `Escrow.sol` — multi-arbiter dispute engine

```
openDispute{value: disputeFee}   →   picks up to 3 eligible, non-party arbiters
        │
        ├─ commitVote(id, round, hash)     COMMIT phase
        ▼
        ├─ revealVote(id, round, outcome, salt)   REVEAL phase
        ▼
        ├─ resolveDispute(id)              tally (2-of-3 quorum; tie → Split)
        ▼
        ├─ appeal(id){value}                optional, within appealWindow
        ▼
        └─ finalizeDispute(id)             payout + majority rewards + penalties
```

- **Selection** — random draw over the registry roster using `prevrandao` +
  block metadata; parties are always excluded. Reverts if < 2 eligible arbiters.
- **Commit–reveal** — `keccak256(abi.encode(outcome, salt, arbiter, milestoneId, round))`;
  reveals open only after the commit deadline, so nobody can copy a vote.
- **Quorum** — 2 of 3. If a third arbiter never responds, the remaining two decide.
  If fewer than 2 reveal, a **no-quorum fallback** refunds the opener and returns
  the milestone to `Submitted`.
- **Rewards** — the dispute fee funds the majority arbiters' reward; minority and
  non-revealers are penalised via trust score.
- **Appeal** — a party may appeal within `appealWindow` by paying another dispute
  fee; a changed outcome slashes the original majority −25 each.
- **Money events are frozen** (`MilestoneFunded/Submitted/Released/Refunded/Split/Cancelled`)
  so the backend money indexer is unaffected; the new dispute events are additive.

### `OpenLanceTimelock.sol`

A zero-overhead subclass of OZ `TimelockController` (no extra storage/logic) that
gives the deployment scripts a project-owned artifact.

### `SponsorshipForwarder.sol` — gasless money actions (ERC-2771)

Lets a signed-in user move money without paying gas. The user signs an EIP-712
`SponsorshipSession` voucher **once at login**; every action is then a signed
`ForwardRequest` submitted by the server relayer, which fronts the gas (and the
principal on testnet).

```
login   → SponsorshipSession{owner,issuedAt,expiry,sessionId}   (EIP-712)
action  → ForwardRequest{from,to,value,gas,nonce,deadline,data} (EIP-712)
relayer → execute(req, sessionId, sig)
             ├─ nonce matches OZ Nonces(from)
             ├─ req signed by `from`
             ├─ session registered + unexpired
             └─ to.call{value}(data || from)   ← ERC-2771 suffix
```

- **On-chain authority** — the contract re-verifies the session voucher, request
  signature, and nonce on every execution; nothing about a call is trusted from
  the backend. A leaked relayer key can only relay calls users already signed.
- **Targets trust it** — `Escrow` / `ArbiterRegistry` inherit
  `ERC2771ContextLite` (storage-based trusted forwarder for UUPS) and read the
  real caller via `_msgSender()`, so `client == user` on-chain, never the relayer.
  Direct user-paid calls are unchanged (forwarder unset → plain `msg.sender`).
- **Eviction** — callers may overpay `msg.value`; the excess is refunded. The
  forwarder is not upgradeable (it holds no funds); repoint targets via
  `setTrustedForwarder` (owner/timelock) to migrate.

## Layout

```
contracts/            Solidity sources
  Escrow.sol          milestone escrow (UUPS)
  ArbiterRegistry.sol soulbound arbiter registry (UUPS)
  IArbiterRegistry.sol interface the escrow depends on
  SponsorshipForwarder.sol  ERC-2771 gasless meta-tx forwarder + EIP-712 sessions
  ERC2771ContextLite.sol    ERC-2771 _msgSender support for UUPS proxies
  OpenLanceTimelock.sol  OZ TimelockController (owner of both proxies)
  test/ReentrancyAttacker.sol  test-only probe
test/                 TypeScript + viem test suite (72 tests)
scripts/
  deploy.ts           timelock + forwarder + both proxies + wiring (Base Sepolia / localhost)
  execute-timelock.ts execute a queued timelock op
  handoff-timelock.ts hand control to a Safe multisig
  export-abi.ts       emit ABI JSON the backend can import
hardhat.config.ts     networks, solc, fuzz/invariant profiles
SECURITY.md           review, findings disposition, invariants
slither.config.json   static-analysis config
```

## The interface contract with the backend

The backend indexer (`src/server/chain/abi.ts`) decodes the **frozen money
events** plus the new dispute/registry events. `test/event-surface.ts` **locks
every topic hash and both enum ordinals**, so a Solidity rename that would break
the indexer fails the build instead of production.

| Event (frozen money) | Topic hash |
|---|---|
| `MilestoneFunded` | `0x6527340e…0ddf` |
| `MilestoneSubmitted` | `0x90143ae4…39a7` |
| `MilestoneReleased` | `0x7891dccf…c966` |
| `DisputeResolved` | `0x0a1a08d0…c12a` |
| `TrustScoreUpdated` | `0x54807645…03c3` |
| `ArbiterRegistered` | `0xe4fa94e2…cab6` |

New (additive) events: `ArbitersSelected`, `VoteCommitted`, `VoteRevealed`,
`DisputeFinalized`, `ArbiterRewarded`, `ArbiterPenalized`, `NoQuorumFallback`,
`AppealOpened`, `AppealResolved`, `ScoreChanged`, `StakeDeposited`, `StakeLocked`,
`StakeWithdrawn`, `StakeSlashed`.

## Security

See [`SECURITY.md`](./SECURITY.md). Summary:

- **0 High / 0 Medium** Slither findings on the production contracts.
- Both implementations pass the OpenZeppelin upgrade-safety validator.
- Tests cover: UUPS authorization, implementation squatting, storage survival,
  reentrancy, solvency, wei-exact conservation, soulbound enforcement, one-shot
  wiring, direct-transfer rejection, fee snapshots, **staking, stake locking,
  score penalties/rewards, quorum, no-quorum fallback, and stake slashing**.

## Known simplifications

- Push payments (a reverting recipient blocks its own settlement); the upgrade
  path is a pull-payment fallback.
- **Arbiter randomness** uses `prevrandao`, which is producer-influenceable.
  Bounded exposure (only *which eligible* arbiter is drawn; money still gated by
  the 2-of-3 quorum + staking); migrate to a VRF via upgrade for mainnet.
- Appeals **do not reverse** an already-executed payout — the appeal window
  precedes finalization, so the payout happens once, after the window closes.
- The timelock owner is trusted for fee/parameter changes, treasury, arbiter
  registry repointing and upgrades — mitigated by the 48h delay + a Safe multisig.
