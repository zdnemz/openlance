# OpenLance — milestone escrow for freelance work

A portfolio-grade implementation of the OpenLance PRD: a freelance
marketplace where every milestone's value is locked in a smart-contract
escrow **before** the work starts, released on proof, and arbitrated by
SBT-staked arbiters when parties disagree.

Three deliverables, one repo:

| Piece | Where | What it proves |
|---|---|---|
| **Contracts** | [`apps/contracts`](./apps/contracts) | Solidity 0.8.28 + OZ 5.6 on **Hardhat 3**: `Escrow` + `ArbiterRegistry` (ERC-5194) + `SponsorshipForwarder` (ERC-2771), both money contracts **UUPS-upgradeable** behind an OZ **TimelockController**. 93 tests incl. event-surface lock, upgrade-safety, reentrancy, and sponsored-meta-tx/EIP-712 proofs; Slither clean. |
| **API** | [`apps/api`](./apps/api) | A standalone **Hono** service on `:4000`: SIWE auth, marketplace, dispute coordination, chain indexer/mirror, transactional-outbox webhooks. It owns the background workers. Supabase Postgres + Upstash Redis caching. |
| **Web** | [`apps/web`](./apps/web) | Next.js 16 product UI against the live stack: wallet-first auth, milestone state machine, real on-chain actions, arbiter surface. Pages only — the browser talks to the API service directly. |

## The devnet stack (what's running)

```
anvil :8545 ── Escrow + ArbiterRegistry (fresh deploy per boot)
    │                ▲
    │  (JSON-RPC     │  (poll logs, re-derive
    │   relay)       │   money truth via RPC)
    │                │
browser ──► apps/web :3000 ──fetch──► apps/api :4000 ── Supabase Postgres
   signs with      (pages)            (the API service)  + Upstash Redis (cache)
   anvil personas                        │
                                          └── owns the indexer + crons
```

- **Two services, two origins**: `apps/web` serves pages on `:3000`; `apps/api`
  is a standalone Hono service on `:4000` that the browser calls directly. The
  API answers its own CORS preflights and owns auth, the database, and the
  chain indexer. There is no BFF in between.
- **Personas**: the connect panel offers five anvil deterministic accounts
  (public test keys) that sign locally in the browser — one click = wallet +
  SIWE session. A real browser wallet (MetaMask) rides the same surface via
  the injected provider; it needs the anvil network added locally
  (chain 31337, RPC `<API_BASE>/api/rpc`).
- **State split enforced in the UI**: money-relevant views poll the API
  mirror, and every wallet action waits through three honest phases —
  *signing → mining → indexer mirroring* — before declaring success.
- **Boot self-healing**: the API service supervises the chain stack through
  `scripts/anvil/dev-real.sh`: anvil → build + deploy (Hardhat 3, UUPS proxies
  behind a timelock) → write contract addresses to `.env.local` → migrate.
  `POST /api/dev/stack?force=1` restarts it on demand (development only).

## Running the stack

The API needs a Postgres connection string (Supabase or any Postgres) and,
optionally, Upstash Redis for cache / rate limits (an in-process fallback keeps
local dev zero-infra).

```bash
pnpm install                        # once — also links .env.local into web + api
cp .env.example .env.local          # set DATABASE_URL (+ Upstash/Supabase optional)
pnpm db:migrate                     # drizzle-kit push schema → DATABASE_URL
pnpm chain                          # anvil + deploy contracts + migrate (optional)
pnpm dev                            # web :3000 + api :4000
```

`pnpm db:flush` empties every table in `public` (dev only) — it prompts before
truncating, and `--yes` skips the prompt. `pnpm chain` boots a fresh anvil with
new contract addresses, so a mirror left over from the previous boot points at
contracts that no longer exist; flushing is the DB half of that reset.

`pnpm dev` starts the two app services in parallel. The chain is a separate
step on purpose: it binds `:8545`, so it must not fight an anvil you already
have running. Per-service env references live in
[`apps/api/.env.example`](./apps/api/.env.example),
[`apps/web/.env.example`](./apps/web/.env.example) and
[`apps/contracts/.env.example`](./apps/contracts/.env.example).

Key env vars (see [`.env.example`](./.env.example)):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string (required) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis: SIWE nonces, JWT denylist, rate limits, read cache (optional) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase Storage + Realtime (optional) |
| `SUPABASE_JWT_SECRET` | HS256 secret; the SIWE session token doubles as a Supabase JWT (required in prod) |
| `CHAIN_MODE` `CHAIN_RPC_URL` `ESCROW_ADDRESS` `ARBITER_REGISTRY_ADDRESS` | chain indexer (mock by default) |
| `SPONSORSHIP_FORWARDER_ADDRESS` `RELAYER_PRIVATE_KEY` | gasless sponsorship (ERC-2771 forwarder + relayer). Both required; unset → user-paid gas |

### Gasless money actions (sponsored meta-txs)

Signed-in users pay **no gas** for state-changing actions. The relayer sponsors
**state, never value**: any call that moves principal — in (escrow funding,
stake deposit/top-up, dispute fee) or out (`withdrawStake`) — is a normal
user-paid transaction. The design:

1. **Login** — after SIWE succeeds the client signs ONE extra EIP-712
   `SponsorshipSession` voucher (`owner, issuedAt, expiry, sessionId`). It
   expires with the login session (JWT TTL) and is stored server-side.
2. **Action** — the client signs an EIP-712 `ForwardRequest` (nonce + deadline
   owned by the server) and POSTs it to `/api/relay`.
3. **Relay** — the server relayer (`RELAYER_PRIVATE_KEY`) submits
   `SponsorshipForwarder.execute(...)` and pays gas. Requests are only relayed
   with `value: 0`, guarded on both sides: `canRelayGasless()` in
   `apps/web/lib/chain-actions.ts` and `assertNoSponsoredValue()` in
   `apps/api/src/modules/sponsorship.ts` (422 `sponsored_value_not_allowed`).
   Proof: `pnpm --filter @openlance/web check:gasless` and
   `pnpm check:sponsored-value`.
4. **On-chain authority** — `SponsorshipForwarder` (ERC-2771) verifies the
   session voucher, the per-request signature, and the nonce; the target
   contract recovers the real user via `_msgSender()`. `Escrow` and
   `ArbiterRegistry` trust the forwarder, so `client == user` on-chain, never
   the relayer. A leaked relayer key cannot move funds users did not sign for.

Relevant files: `apps/contracts/contracts/SponsorshipForwarder.sol`,
`apps/contracts/contracts/ERC2771ContextLite.sol`,
`apps/api/src/modules/sponsorship.ts`, `apps/api/src/chain/relayer.ts`,
`apps/api/src/routes/relay/**`, `apps/web/lib/sponsorship.ts`. Tests:
`apps/contracts/test/sponsorship.ts`, `apps/contracts/test/eip712-agreement.ts`.

> Testnet only: the relayer fronts gas alone, so give it test ETH for gas.
> A per-user hourly cap (`SPONSORSHIP_RATE_LIMIT_PER_HOUR`) bounds relayer drain.

### Repo layout

```
apps/api/             the API service (Hono, :4000) — runs on plain Node, no build
  src/server.ts       entrypoint: validate config, boot workers, listen
  src/app.ts          Hono app: CORS, 404, the route table
  src/routes.ts       generated from routes/ — the index of the API surface
  src/routes/**       one module per path, `route()` wrapped (same contract as before)
  src/config.ts       env schema (Supabase + Upstash), derived config
  src/db/             Drizzle schema + Supabase Postgres client
  src/lib/            kv (Upstash), cache, jwt, rate-limit, http, errors, queue
  src/auth/           SIWE + session middleware
  src/chain/          adapter (real/mock), relayer (sponsored meta-txs), events, indexer, reconcile
  src/modules/        jobs, proposals, projects, disputes, files, sponsorship, … 
  src/workers/        webhook delivery + crons
  scripts/            check:routes (table vs tree), gen:routes, verify scripts
apps/web/             the Next.js UI (:3000) — pages only
  proxy.ts            onboarding + seat gate (reads the cookies the API stamps)
apps/contracts/       Hardhat 3 Solidity
scripts/              link-env.mjs (one .env.local → both services), anvil/
schema pushes straight to DATABASE_URL via `drizzle-kit push` (no migration files)
```

`pnpm check:routes` fails if `src/routes.ts` and the `routes/` tree ever
disagree — the one failure mode a 70-file move can produce silently.

## Key routes

`/` cinematic landing · `/jobs` marketplace · `/jobs/:id` propose/award ·
`/jobs/new` job post (brief + max budget) · `/dashboard` role-aware control room ·
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
