# OpenLance — Contracts

The on-chain money authority of OpenLance (PRD build phase 2): **one escrow contract** holding every milestone — not a factory of per-project clones, because dispute/arbiter/fee/settlement logic is cross-project and a single accounting surface is what the invariant suite protects (PRD §7.2).

**Stack:** Solidity 0.8.28 · Foundry (forge test / fuzz / invariants) · OpenZeppelin 5.7 (ERC-721, ERC-5194, Ownable, ReentrancyGuard) · native ETH (ERC-20 is upgrade Tier 3).

```
forge install            # already vendored in lib/ if you have the repo
forge build
forge test               # 90 tests: unit + event-surface lock + invariant fuzz
FOUNDRY_PROFILE=ci forge test   # 1000 fuzz runs, 512×256 invariants
forge coverage           # Escrow 100% lines / 97.4% branches · Registry 100% / 98.3%
```

---

## The two contracts

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

- **`fund(bytes32 ref, address freelancer)`** — the off-chain milestone uuid travels in the funding tx (`ref`), so the backend indexer maps on-chain ids → database rows deterministically. Fee is **snapshotted per milestone**; later `setFeeBps` changes never touch in-flight work.
- **`approve`** — fee on released value only (floor: `amount × bps / 10_000`, byte-identical to the backend's `feeOf`).
- **Dispute coordination, trust-minimized:** either party `nominateArbiter`; the moment both nominate the same registered arbiter, the assignment locks and the 72h SLA clock starts — no platform involvement. `adminAssignArbiter` only unlocks after the 48h agreement window lapses (PRD F10).
- **`resolveDispute`** — release (fee on full) / refund (no fee) / split (50/50, fee on the freelancer half only, odd wei to the client, exact conservation). Event order is load-bearing and matches the backend mock byte-for-byte: `DisputeResolved` → settlement → `TrustScoreUpdated`.
- **`slashStaleArbiter`** — permissionless after SLA + 24h grace: deregisters the arbiter, clears the assignment, dispute stays open for reassignment.
- **CEI + `nonReentrant` on every payout path.** Direct ETH transfers revert (`receive()`), so contract balance always maps 1:1 to tracked liabilities.

### `ArbiterRegistry.sol` — soulbound identity + on-chain trust (PRD F11/F12)

- ERC-5194 soulbound badges: minted locked, transfers **and** burns revert, `locked()` + `Locked` event per the spec. Deregistration keeps the badge (history); re-registration mints a fresh one.
- Trust score is a pure function of resolution history, driven only by the escrow: **+1 within SLA, −2 late, floored at zero**. The backend mirror never hand-edits it — it folds `TrustScoreUpdated` events.
- `recordResolution` / `slash` are escrow-only; registration is platform-vetted (owner).

### The interface contract with the backend

The backend's indexer (`mini-services/api/src/chain/abi.ts`) decodes exactly these 12 events + `milestoneStatus(uint256)→uint8` (enum ordinals are API — see `ONCHAIN_MILESTONE_STATUS`). **`test/EventSurface.t.sol` locks every topic hash and both enums to the TypeScript ABI**, so a Solidity rename that would break the indexer fails the build instead of production.

## Invariants (the PRD §7.4 core, fuzzed with a ghost-accounting handler)

After every one of ~65k randomized action sequences (512 runs × 128 depth, CI profile), with reverts, wrong actors and time jumps mixed in:

1. **Solvency** — `contract balance ≥ Σ unsettled milestone amounts + accrued fees`.
2. **Balance is exactly liabilities** — the stronger form this implementation achieves.
3. **Conservation** — every wei that entered via `fund()` is still in the contract or left via a legitimate payout. Nothing leaks, nothing is created, nothing is paid twice.
4. **Fee-pot mirror** — `accruedFees` equals the ghost sum of every fee the flows ever accrued.
5. **No double settle** — settled milestones are terminal forever.

The fuzzer earned its keep twice: the shrinker found a direct-to-contract `fund()` that bypassed the handler's ghost accounting (fixed by excluding the contracts from direct targeting — the handler is the only door), and the CI profile's deeper sequences verified the split path's odd-wei conservation.

## Testing highlights

- **Two-layer reentrancy proof** — an attacker contract reenters mid-payout and *captures the inner revert + the on-chain status it observed*: same-milestone reentry dies on the guard (modifier precedence) while CEI had already flipped the status (a guard bypass would still hit `WrongStatus`); cross-milestone reentry passes every state check and only the guard stops it.
- **Fee-snapshot semantics** — fund at 250 bps → `setFeeBps(500)` → both milestones settle with their own snapshots.
- **Fuzz conservation** — release and split math conserve to the wei for any amount ≤ 1e30 and any fee ≤ 500 bps.
- Gas snapshot in `.gas-snapshot` (approve ≈ 328k, resolve-split ≈ 601k test-gas incl. setup).

## Deploying

```bash
# local anvil
anvil --block-time 1 --chain-id 31337
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key $ANVIL_KEY0 --broadcast

# Base Sepolia (fund from a faucet first)
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_KEY --broadcast --verify
```

Deploy order is wired in the script: registry → escrow(registry) → `registry.setEscrow(escrow)`. The deployer becomes admin/owner. Point the backend at the printed addresses:

```env
CHAIN_MODE=real  CHAIN_ID=84532
ESCROW_ADDRESS=0x…  ARBITER_REGISTRY_ADDRESS=0x…
```

## Anvil end-to-end (the phase-2 demo)

`bun run e2e:anvil` (from `mini-services/api`) spins up the whole stack in one process tree — anvil, a fresh deployment, the API in `CHAIN_MODE=real` against a fresh embedded DB — and replaces every `/dev/chain/*` call from the mock smoke test with a **real wallet transaction**:

job → proposal → award → `fund` → `submit` → `approve` → **RPC-verified reviews** → dispute → **on-chain mutual nomination** → `resolve(split)` → trust score +1 → fee withdrawal → **live solvency check** (`balance == accrued fees`) → zero-drift reconciliation.

It passes. That's the proof the adapter seam was honest: the backend was built against the mock chain, and the real contracts dropped in without a single change to the indexer, mirror or webhook pipeline.

## Known simplifications (documented, not hidden)

- Push payments only (no pull-payment fallback) — a rejecting receiver wallet reverts the settlement. Fine for EOA-based MVP; the upgrade path is pull payments.
- `withdrawFees` reverts on zero (the mock emits a zero-amount event instead) — error-path divergence only.
- Arbiter registration is owner-gated (platform-vetted); the PRD's "anyone can register" path is a future governance decision.
- A deregistered-after-assignment arbiter can still resolve; their (skipped) trust-score update emits no event, keeping the mirror consistent by construction.
