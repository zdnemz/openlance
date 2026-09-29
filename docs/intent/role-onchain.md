# Intent — role on-chain

Confirmed 2026-09-29. Source of this document is an interview, not a spec: every
line below was agreed out loud. Design details that were *not* agreed are marked
**Open** and are not settled by this file.

## Outcome

A wallet's role lives on-chain, not in Postgres.

- `claim(role)` — free, once per wallet, during onboarding.
- `switchRole(role) {value: fee}` — every later change, priced on-chain.

`users.role` stops being a source of truth and becomes a mirror rebuilt from
contract events.

## User

A wallet that signs in again after the database was wiped does not lose its seat,
and cannot have its seat taken by another wallet.

## Why now

Role is the only piece of state a wallet actually *owns* that still dies with
its `users` row. Arbiter standing (stake · trust score · tier) already reads
live from `ArbiterRegistry` — role was the last DB-authority exception, and the
one that hurts when the DB is lost.

## Success

- Wipe the DB, replay the event log → `role`, `stake`, `trustScore`, milestone
  money state and totals come back identical.
- Changing a role always costs a transaction; a free write exists exactly once
  per wallet.
- An arbiter with `stakeOf > 0` cannot leave the arbiter role.

## Constraint

- Authored content — bio, job brief, proposal text, chat, attachments — stays in
  Postgres and is **not** disposable. It is backed up. Anchoring it to IPFS or
  putting it on-chain is a separate decision that was explicitly declined.
- The guarantee is therefore narrower than "the DB can be wiped": *wallet-owned
  facts survive total DB loss; platform-issued and user-authored facts survive
  because the DB is backed up.*
- Rollback must stay possible.

## Out of scope

- KYC stays in the DB and stays mock. It is a platform-issued credential, not
  something the wallet owns, so it does not belong on-chain. **Known tension:**
  `requireKyc` gates nearly every write, so a wipe does lock users out until
  they re-verify.
- No IPFS / Arweave content anchoring.
- No events for the marketplace domain yet. Role is the first; the rest follow.
- No cooldown mechanism — the fee is the only price on a role change. One
  mechanism, not two.

## Defaults chosen (Open to revisit)

- Fee → platform treasury, `setRoleChangeFee` is owner-only (timelocked in prod).
- "Locked" means free writes end at the first `claim`; afterwards `switchRole`
  is the only path that can change a role.
- Becoming an arbiter still requires `registerArbiter` with `minStake` as
  today. Only *leaving* the arbiter role is stake-gated, so `role=arbiter` with
  no standing is a reachable state (harmless — `isEligible` still requires
  stake ≥ `minStake`).
- Role gets its own contract, not a slot in `ArbiterRegistry`: that contract is
  single-responsibility, carries 90 tests at 97% branch coverage, and is the
  Escrow's trust boundary. The cost is one documented `staticcall` edge for the
  stake check.

## The spine

1. Session identity is anchored to the wallet address, not a Postgres uuid, so
   sessions outlive a DB wipe.
2. A missing user row routes to onboarding instead of 401-ing.
3. Onboarding reads the role from chain, writes the row, then locks.
4. Changing a role is a paid transaction.

Step 1 was originally assumed to be a hard prerequisite. On reading the code it
is not: `verifyLogin` already re-creates the row by `walletAddress`, so a wiped
DB costs a re-login, not an account. Anchor the session to the address because it
is cheap and it is the right identity anchor — not because anything is broken
without it.
