# Intent: arbiter consistency (confirmed)

- Outcome: chain/backend/frontend agree on selectable, tiers, deadlines, and off-chain saves.
- User: arbiters + disputing parties seeing one truth.
- Why now: stake/duration/tier drift was user-visible (selectable countdowns, rank badges, dispute rows).
- Success: no revert-signable UI + mirrors match `tierOf`/`isEligible`/`getRound`.
- Constraint: no contract changes (event surface locked).
- Out of scope: historical tier recompute, real-time chain polling in backend.
