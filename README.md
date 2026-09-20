# OpenLance — milestone escrow for freelance work

A portfolio-grade implementation of the OpenLance PRD: a freelance
marketplace where every milestone's value is locked in a smart-contract
escrow **before** the work starts, released on proof, and arbitrated by
SBT-staked arbiters when parties disagree.

Three deliverables, one repo:

| Piece | Where | What it proves |
|---|---|---|
| **Contracts** | [`contracts/`](./contracts) | Solidity 0.8.28 + OZ 5.6 on **Hardhat 3**: `Escrow` + `ArbiterRegistry` (ERC-5194), both **UUPS-upgradeable** behind an OZ **TimelockController**. 39 tests incl. event-surface lock, upgrade-safety and reentrancy proofs; Slither clean. |
| **Backend** | [`src/server`](./src/server) + [`src/app/api`](./src/app/api) | Next.js server runtime (App Router route handlers): SIWE auth, marketplace, dispute coordination, chain indexer/mirror, transactional-outbox webhooks. Supabase Postgres + Upstash Redis caching. |
| **Frontend** | `src/` (this app) | Next.js 16 product UI against the live stack: wallet-first auth, milestone state machine, real on-chain actions, arbiter surface. |

## The devnet stack (what's running)

```
anvil :8545 ── Escrow + ArbiterRegistry (fresh deploy per boot)
    │                ▲
    │  (same-origin  │  (poll logs, re-derive
    │   JSON-RPC     │   money truth via RPC)
    │   relay)       │
browser ──────► Next.js :3000 ── /api route handlers ── Supabase Postgres
   signs with            │                              + Upstash Redis (cache)
   anvil personas        └── seeded demo data, driven by REAL transactions
```

- **One app, one origin**: the API is no longer a separate service — it runs
  inside the Next.js server as App Router route handlers under `/api/**`
  (`src/app/api`), with the domain logic in `src/server`. No CORS, no gateway
  port forwarding from the client.
- **Personas**: the connect panel offers five anvil deterministic accounts
  (public test keys) that sign locally in the browser — one click = wallet +
  SIWE session. A real browser wallet (MetaMask) rides the same surface via
  the injected provider; it needs the anvil network added locally
  (chain 31337, RPC `<origin>/api/rpc`).
- **State split enforced in the UI**: money-relevant views poll the API
  mirror, and every wallet action waits through three honest phases —
  *signing → mining → indexer mirroring* — before declaring success.
- **Boot self-healing**: the Next.js server babysits the chain stack through
  `scripts/anvil/dev-real.sh`: anvil → build + deploy (Hardhat 3, UUPS proxies
  behind a timelock) → write contract addresses to `.env.local` → migrate →
  demo seed (idempotent). `POST /api/dev/stack?force=1` restarts it on demand.

## Running the backend

The backend lives in the same Next.js app. It needs a Postgres connection
string (Supabase or any Postgres) and, optionally, Upstash Redis for cache /
rate limits (an in-process fallback keeps local dev zero-infra).

```bash
cp .env.example .env.local        # set DATABASE_URL (+ Upstash/Supabase optional)
bun install
bun run db:migrate                # drizzle-kit push schema → DATABASE_URL
bun run db:seed                   # demo cast + a partially-progressed project
bun run dev                       # Next.js + the API on :3000
```

Key env vars (see [`.env.example`](./.env.example)):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string (required) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis: SIWE nonces, JWT denylist, rate limits, read cache (optional) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase Storage + Realtime (optional) |
| `SUPABASE_JWT_SECRET` | HS256 secret; the SIWE session token doubles as a Supabase JWT (required in prod) |
| `CHAIN_MODE` `CHAIN_RPC_URL` `ESCROW_ADDRESS` `ARBITER_REGISTRY_ADDRESS` | chain indexer (mock by default) |

### Backend layout

```
src/app/api/**        route handlers (the HTTP surface — same paths as before)
src/server/           domain logic, ported 1:1 from the old Hono service
  config.ts           env schema (Supabase + Upstash), derived config
  db/                 Drizzle schema + Supabase Postgres client
  lib/                kv (Upstash), cache, jwt, rate-limit, http, errors, queue
  auth/               SIWE + session middleware
  chain/              adapter (real/mock), events, indexer, reconcile
  modules/            jobs, proposals, projects, disputes, files, … 
  workers/            webhook delivery + crons
  proxy.ts            CORS + OPTIONS preflight for /api/**
scripts/              seed.ts, anvil/ (dev chain tooling); schema pushes straight
                      to DATABASE_URL via `drizzle-kit push` (no migration files)
```

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
- **Gateway requests removed**: the API is same-origin now — the client calls
  `/api/**` directly (`src/lib/api.ts`), no `?XTransformPort` rewriting.

## Frontend design system

Dark premium: zinc-950 base, one deep-rose accent (`#e11d48`), emerald
reserved for money-released semantics, Geist + Geist Mono (every wei amount,
hash, and timestamp is mono/tabular). Motion budget: cinematic landing
(parallax hero, sticky-stack scrolltelling, kinetic marquee), calm app
interior (spring hovers, breathing status dots, shimmer skeletons).
