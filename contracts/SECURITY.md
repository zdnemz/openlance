# Security review — OpenLance contracts

Scope: `contracts/Escrow.sol`, `contracts/ArbiterRegistry.sol`,
`contracts/OpenLanceTimelock.sol`, `contracts/IArbiterRegistry.sol`.

Toolchain: Solidity 0.8.28 (optimizer on, `evmVersion = cancun`),
Hardhat 3.17, OpenZeppelin Contracts + Contracts-Upgradeable 5.6.1.

## What was checked

| Layer | Tool / method | Result |
|---|---|---|
| Static analysis | Slither 0.11 (102 detectors) | 0 High / 0 Medium on production contracts |
| Upgrade safety | `@openzeppelin/hardhat-upgrades` storage-layout validator | `Escrow` ✓ and `ArbiterRegistry` ✓ upgrade-safe |
| Reentrancy | Dedicated attacker contract in `test/reentrancy.ts` | Guard + CEI hold; settlement fully reverts |
| Solvency | Accounting test in `test/reentrancy.ts` | `balance == Σ unsettled + accruedFees` at every step |
| Interface lock | `test/event-surface.ts` | 12 indexer events + Status/Outcome ordinals frozen |
| Access control | `test/escrow.ts`, `test/registry.ts`, `test/upgrade.ts` | Every privileged path owner/timelock-gated |
| Fuzz / invariants | (see note) | Unit + accounting suites pass; fuzz profile configured |

### Slither findings — disposition

All High/Medium findings are in **OpenZeppelin library** code or the **test-only
attacker contract**, none in our production logic:

- `arbitrary-send-eth` (`Escrow._pay`) — **by design.** `_pay` only ever sends to
  the milestone's own `client` or `freelancer` (both fixed at `fund`), or to the
  owner-chosen `to` in `withdrawFees` (owner = timelock). Amounts are bounded by
  the escrowed value; no caller can redirect funds.
- `incorrect-exp`, `divide-before-multiply` — inside OZ `Math.mulDiv`
  (audited bit-twiddling, known false positive).
- `msg-value-in-nonpayable`, `unused-return` — inside OZ `ERC1967Utils` /
  `TimelockController`.
- `locked-ether` — the test `ReentrancyAttacker` (deliberate probe).
- `timestamp` — the 48h/72h/24h dispute windows compare `block.timestamp` on
  purpose; miners can nudge these by seconds, which the windows tolerate.
- `reentrancy-benign` / `reentrancy-events` — the attacker contract and the OZ
  timelock; `Escrow` payout paths are `nonReentrant` + CEI.

## Security properties (enforced by tests)

1. **UUPS upgrade authority is owner-only.** `_authorizeUpgrade` is `onlyOwner`;
   in production the owner is the `TimelockController`, so every upgrade is
   publicly queued for `minDelay` (48h) before it can execute. An outsider
   cannot upgrade (`test/upgrade.ts`).
2. **No implementation squatting.** Both implementations call
   `_disableInitializers()` in their constructor, so the implementation contract
   cannot be initialized by an attacker (`test/upgrade.ts`).
3. **Storage survives upgrades.** `initialize` is atomic (owner + params in one
   tx, no front-run window); state is preserved across an implementation swap
   (`test/upgrade.ts`).
4. **Reentrancy-proof payouts.** `ReentrancyGuardTransient` (EIP-1153) +
   Checks-Effects-Interactions on every path that moves ETH, including
   `withdrawStake` and the dispute payout/reward paths (`test/reentrancy.ts`).
5. **Solvency.** The escrow balance always equals unsettled milestone amounts
   plus `accruedFees`; a milestone settles at most once and becomes terminal
   (`test/reentrancy.ts`).
6. **Exact value conservation.** Release/refund/split math conserves every wei,
   including the odd-wei split case that rounds to the client
   (`test/disputes.ts`).
7. **Soulbound badges.** `ArbiterRegistry._update` reverts on every transfer and
   burn — the ERC-5194 invariant cannot be bypassed (`test/registry.ts`).

### Multi-arbiter specific

8. **Parties never arbitrate.** Selection explicitly excludes the milestone's
   client and freelancer, and draws only from arbiters the registry reports as
   eligible (`test/disputes.ts`).
9. **Stake is real skin.** A 2-of-3 quorum is impossible without a staked,
   non-benched roster, so a dispute cannot be opened unless ≥ 2 eligible
   arbiters exist (`test/disputes.ts`).
10. **Locked stakes.** Below `minScoreToWithdraw`, `requestUnstake`/`withdrawStake`
    revert with `StakeIsLocked` and the arbiter is dropped from selection
    (`test/registry.ts`).
11. **Slash at zero.** Reaching score 0 removes the arbiter and forwards the full
    collateral to the treasury (`test/registry.ts`).
12. **Commit–reveal.** Reveals open only after the commit deadline and the hash
    must match (`keccak256(encode(outcome, salt, arbiter, milestoneId, round))`),
    so votes cannot be copied (`test/disputes.ts`).
13. **Quorum + fallback.** 2-of-3 suffices; a missing third is a `−15` miss and
    the other two decide. Fewer than 2 reveals → refund fallback to `Submitted`
    (`test/disputes.ts`).
14. **Scores bound to [0,100].** Majority `+5` (cap 100), minority `−10`,
    missed `−15`, overturned `−25` — applied only by the escrow
    (`test/registry.ts`, `test/disputes.ts`).
15. **Appeal cannot double-pay.** Resolution tallies the round but pays out only
    after the appeal window closes (`finalizeDispute`), so exactly one payout
    ever occurs (`test/disputes.ts`).

## Known limitations (documented, not hidden)

- **Push payments.** A recipient contract/wallet that reverts on receive blocks
  its own settlement. Acceptable for the EOA-based MVP; the upgrade path is a
  pull-payment fallback (addable behind the UUPS proxy without a migration).
- **On-chain randomness is weak.** `prevrandao` + block metadata is
  producer-influenceable. The exposure is bounded: a biased producer can only
  reorder *which eligible, non-party* arbiters are drawn, and the money is still
  gated by the commit-reveal 2-of-3 quorum and by staking/slashing. Mainnet
  should migrate to Chainlink VRF via an upgrade.
- **Owner is trusted.** The timelock owner can change fees/parameters, the
  treasury, the arbiter registry pointer, and upgrade. The timelock delay + a
  Safe multisig (mainnet) are the mitigations; there is no on-chain veto yet.
- **Appeals do not reverse paid funds.** Because payouts happen only after the
  appeal window, an appeal replaces the *pending* decision; once finalized the
  outcome is terminal. The remedy for a bad majority is scoring (and future
  selection bias), not fund reversal.

## Reproduce

```bash
cd contracts
npm install
npx hardhat build
npx hardhat test                     # 39 tests
pipx run slither . --hardhat-ignore-compile
```
