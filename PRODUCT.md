# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router, Turbopack) + Tailwind CSS v4 + TanStack Query + viem (no wagvi/wagmi — memory); Hono.js API (:3030) + Drizzle/Postgres via env DATABASE_URL; Foundry contracts (Escrow + ArbiterRegistry) on anvil devnet 31337.

## Users

- **Clients** (freelance buyers) posting work broken into milestone templates and funding each milestone on-chain.
- **Freelancers** proposing with their own milestone breakdowns, submitting delivery on-chain, getting paid by contract.
- **Arbiters** holding soulbound badges, resolving disputes inside a 72h SLA.
- **Platform admin** (single operator wallet) running reconciliation and fee exit.
- Demo personae (5 anvil accounts) let any visitor try every seat instantly; this is a portfolio piece, so the visitor IS the user.

## Product Purpose

OpenLance is a milestone-escrow freelance marketplace: value locks in a smart contract before work starts, releases on on-chain proof (not promises), and disputes resolve through SBT-staked arbiters. Success means a visitor can see, in seconds, that the money moves by contract state machine — fund → submit → approve/dispute → release/split — with real tx hashes everywhere.

## Positioning

The contract is the source of truth: the off-chain layer is a mirror, and every money-relevant write re-verifies via RPC. Neighboring marketplaces hold funds in custody accounts; here the escrow is a solvency-invariant contract (balance ≥ Σ unsettled + fees, proven by fuzz tests, 97%+ branch coverage) with permissionless arbiter slashing.

## Operating Context

- Base-native by design; demo runs on anvil (chain 31337) with local persona keys; Base Sepolia is an env flip.
- Wallet hybrid: deterministic anvil personas sign locally in the tab (instant demo), injected wallets via window.ethereum + same-origin relay.
- SIWE (EIP-4361) login mints a Supabase-compatible JWT; identity follows the key.
- Three-phase chain-action UX: signing → mining → indexer mirroring (honest, with mirror-wait).

## Capabilities and Constraints

- Testnet only — no real funds, ever. Show this honestly ("anvil devnet · no real funds, real contracts").
- One accent color (Deep Rose #e11d48); emerald + state hues exist only as milestone-state semantics.
- English copy; mono numerals for all on-chain data (amounts, hashes, refs).
- No attachments upload UI yet (next phase); ERC-4337 paymaster is a planned upgrade.

## Brand Commitments

- Name: OpenLance. Voice: precise, dry, engineering-forward; controls name their action; no marketing fluff.
- Dark premium interior; the landing may be cinematic, the app interior stays calm.
- Typography committed 2026-09-19 (impeccable refactor): Instrument Serif (display), Schibsted Grotesk (UI), IBM Plex Mono (ledger data) — replaces Geist, then Instrument Sans (both detector-flagged as AI-convergent). One accent, structure over glow.

## Evidence on Hand

- Live seeded demo data: 3 jobs, 3 projects in distinct states (funded mid-flight, disputed, completed via split), ranked arbiter registry with real trust scores, 18+ ledger events with real tx hashes.
- 90 Foundry tests, 31 backend tests, E2E smoke green; contracts at 97%+ branch coverage with invariant fuzz suite.

## Product Principles

1. On-chain truth, off-chain convenience — the mirror is cache, never authority.
2. Every state the user sees is a state the contract enforces.
3. Money moments get the most visual weight; everything else recedes.
4. Honesty over theater: no fake balances, no simulated progress, tx hashes link to reality.

## Accessibility & Inclusion

WCAG AA contrast on all ink surfaces (detector-enforced); prefers-reduced-motion honored for all perpetual and entrance motion; visible focus rings in rose; 11px floor for functional text.
