# EscrowLance — milestone escrow for freelance work

A portfolio-grade implementation of the EscrowLance PRD: a freelance
marketplace where every milestone's value is locked in a smart-contract
escrow **before** the work starts, released on proof, and arbitrated by
SBT-staked arbiters when parties disagree.

Three deliverables, one repo:

| Piece | Where | What it proves |
|---|---|---|
| **Contracts** | [`contracts/`](./contracts) | Solidity 0.8.28 + OZ 5.7: `Escrow` + `ArbiterRegistry` (ERC-5194). 90 tests incl. invariant fuzz + event-surface lock to the backend ABI; 97%+ branch coverage. |
| **Backend** | [`mini-services/api`](./mini-services/api) | Hono API on :3030 — SIWE auth, marketplace, dispute coordination, chain indexer/mirror, transactional-outbox webhooks. Runs zero-infra (PGlite/in-process) and flips to Supabase/Redis/Base Sepolia via env. |
| **Frontend** | `src/` (this app) | Next.js 16 product UI against the live stack: wallet-first auth, milestone state machine, real on-chain actions, arbiter surface. |

## The devnet stack (what's running)

```
anvil :8545 ── Escrow + ArbiterRegistry (fresh deploy per boot)
    │                ▲
    │  (same-origin  │  (poll logs, re-derive
    │   JSON-RPC     │   money truth via RPC)
    │   relay)       │
browser ──────► Next.js :3000 ──────► Hono API :3030 ── PGlite (mirror/cache)
   signs with            │
   anvil personas        └── seeded demo data, driven by REAL transactions
```

- **Personas**: the connect panel offers five anvil deterministic accounts
  (public test keys) that sign locally in the browser — one click = wallet +
  SIWE session. A real browser wallet (MetaMask) rides the same surface via
  the injected provider; it needs the anvil network added locally
  (chain 31337, RPC `<origin>/api/rpc`).
- **State split enforced in the UI**: money-relevant views poll the API
  mirror, and every wallet action waits through three honest phases —
  *signing → mining → indexer mirroring* — before declaring success.
- **Boot self-healing**: the Next.js server babysits the chain stack through
  `mini-services/api`'s `dev` script (`scripts/dev-real.sh`): anvil → deploy
  (viem, from `contracts/out` artifacts) → fresh DB → API (real mode) → demo
  seed (idempotent). `POST /api/dev/stack?force=1` restarts it on demand.

## Demo data (created by real transactions at boot)

- **3 open jobs** (bridge audit, realtime dashboard, NFT drop) with milestone
  templates and 6 proposals from the personas.
- **Project A** (audit, Dario): m1 released + both-side reviews, m2 funded
  (freelancer submits from the UI), m3 fundable.
- **Project B** (dashboard, Rhys): m1 disputed — drive the nomination and
  resolution yourself from the parties' and arbiter's seats.
- **Project C** (NFT drop): completed via mutual arbiter nomination and a
  split resolution; arbiter trust score +1, chat + reviews recorded.

## Key routes

`/` cinematic landing · `/jobs` marketplace · `/jobs/:id` propose/award ·
`/jobs/new` milestone builder · `/dashboard` role-aware control room ·
`/projects/:id` the project room (state machine + chat + on-chain activity) ·
`/disputes` arbiter queue · `/arbiters` SBT trust registry · `/profile/:address`
public identity · `/admin` reconciliation + fees · `/console` backend console.

## Engineering notes (the honest bits)

- **wagmi was removed on purpose**: the 4GB dev box could not hold a turbopack
  dev server with the wagmi module graph alongside the chain stack (repeated
  OOM kills at ~2.9GB). The wallet layer (`src/lib/wallet.ts`) is ~150 lines
  of viem — local persona accounts + an injected-provider path — which cut
  the dev server's settled footprint from ~2.4GB to ~1.5GB.
- **Phosphor icons are imported per-icon** (`dist/csr/*`): the barrel import
  drags ~3000 modules into the dev compile.
- **SIWE gotcha**: the parser enforces strict EIP-55 checksums — anvil's
  displayed casing is NOT EIP-55, so the frontend checksums with viem's
  `getAddress()` before building the message.
- **Gateway requests**: through the preview proxy every API call is a
  relative path + `?XTransformPort=3030`; on localhost:3000 the client talks
  to `http://localhost:3030` directly (CORS-listed server-side).

## Frontend design system

Dark premium: zinc-950 base, one deep-rose accent (`#e11d48`), emerald
reserved for money-released semantics, Geist + Geist Mono (every wei amount,
hash, and timestamp is mono/tabular). Motion budget: cinematic landing
(parallax hero, sticky-stack scrolltelling, kinetic marquee), calm app
interior (spring hovers, breathing status dots, shimmer skeletons).
