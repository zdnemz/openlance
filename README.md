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
| **Web** | [`apps/web`](./apps/web) | Next.js 16 product UI against the live stack: wallet-first auth, milestone state machine, real on-chain actions, arbiter surface. Pages only — the browser talks to the API service directly (cross-origin locally, same-origin on Vercel). |

## The devnet stack (what's running)

```
anvil :8545 ── Escrow + ArbiterRegistry + RoleRegistry (fresh deploy per boot)
    │                ▲
    │  (JSON-RPC     │  (poll logs, re-derive
    │   relay)       │   money truth via RPC)
    │                │
browser ──► apps/web :3000 ──fetch──► apps/api :4000 ── Supabase Postgres
   signs with      (pages)            (the API service)  + Upstash Redis (cache)
   anvil personas                        │
                                          └── owns the indexer + crons
```

- **Two services**: `apps/web` serves pages; `apps/api` is a standalone Hono
  service that the browser calls directly. It owns auth, the database, and the
  chain indexer. There is no BFF in between. Locally (`pnpm dev`) and
  self-hosted (Caddy) they are two origins (`:3000` / `:4000`), so the API
  answers its own CORS preflights. On Vercel they are two services of one
  project behind ONE domain, so the browser calls `/api/*` same-origin — see
  [Deploying on Vercel](#deploying-on-vercel-services).
- **Wallets**: users connect an injected browser wallet (MetaMask etc.); the
  panel switches or adds the env chain and asks for one SIWE signature. The
  anvil persona keys are gone. Locally the chain is 31337, RPC
  `<API_BASE>/api/rpc` (read methods and raw sends only).
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
pnpm db:migrate                     # apply apps/api/drizzle/*.sql → DATABASE_URL
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
| `ROLE_REGISTRY_ADDRESS` | the wallet-owned seat. Set → sign-in re-seats from the chain and a role write is refused unless the wallet already claimed that seat on-chain. Unset → the `users.role` column is the seat (pre-RoleRegistry behaviour) |
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
  src/serve.ts        long-lived entrypoint: validate config, boot workers, listen
  src/app.ts          Hono app: CORS, 404, the route table — also the serverless entrypoint
                      (Vercel); crons via GET /api/internal/cron
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
scripts/              link-env.mjs (one .env.local → both services), anvil/,
                      check-vercel.mjs (`pnpm check:vercel`: validates vercel.json)
vercel.json             Vercel services config (api + web, one domain) — see "Deploying on Vercel"
schema changes are versioned SQL in apps/api/drizzle/, applied by `pnpm db:migrate`
```

`pnpm check:routes` fails if `src/routes.ts` and the `routes/` tree ever
disagree — the one failure mode a 70-file move can produce silently.

## Deploying on Vercel (services)

One Vercel project, two [services](https://vercel.com/docs/services), one domain.
The root [`vercel.json`](./vercel.json) is the whole configuration:

| Service | Root | Framework | Public path | Notes |
|---|---|---|---|---|
| `api` | `apps/api` | `hono` | `/api/(.*)` | Entrypoint `src/app.ts` (auto-detected; it default-exports the Hono app). `src/serve.ts` is the long-running Node entry for VMs and `pnpm dev`, never used on Vercel. `functions["src/app.ts"].maxDuration` is `60`. |
| `web` | `apps/web` | `nextjs` | `/(.*)` (catch-all, last) | `buildCommand` is `pnpm run build:vercel`: the default `build` ends in `finalize-standalone.mjs`, which exits 1 on Vercel (`output: "standalone"` is skipped there). |

- **Routing.** Rewrites run top to bottom: `/api/(.*)` goes to `api`, everything
  else to `web`. Both services are public; none is internal.
- **No prefix strip.** The API registers every route WITH the `/api` prefix
  (`src/routes.ts` is generated that way), so the service must see the original
  path. There is deliberately no `request.path` transform on `api`: a strip such
  as `args: "/$1"` would 404 every request. Verified with `vercel build` 62.2.0:
  the service's own route table carries literal `^/api/...` patterns and, with no
  `routePrefix`, the builder emits a no-op `/$1`. Runtime path preservation
  through the router is still a first-deploy check (`GET /api/health`).
- **No bindings.** A binding is declared on the *calling* service and injects the
  target's internal URL, and only functions can read it (not builds, not
  middleware). Nothing here qualifies: every page is a client component, so the
  browser calls `/api/*` itself, same-origin through the rewrite; the one
  server-side call, the awarded-job lookup in `apps/web/proxy.ts`, runs in the
  Next proxy (middleware), where bindings do not resolve, so it calls its own
  origin; and the API never calls the web app (its only web dependency is origin
  config: `APP_URI`). If a route handler or server component later needs the API,
  add `{ "type": "service", "service": "api", "format": "url", "env": "API_URL" }`
  to `services.web.bindings` and read it as
  `new URL("api/...", process.env.API_URL)`; never set that variable yourself.
- **Web build.** `NEXT_PUBLIC_API_BASE` is inlined at build time. When `VERCEL`
  is set and the variable is unset, `apps/web/next.config.ts` defaults it to the
  empty string, so the browser and the proxy use same-origin `/api/...` instead of
  `localhost:4000`. Leave it UNSET in the Vercel project.
- **Validation.** `pnpm check:vercel` (also a CI step) checks `vercel.json`
  against these rules: no top-level build keys, catch-all last, the API behind an
  object-form rewrite, every API route under the public prefix, the entrypoint
  Vercel would pick (not `serve.ts`), `functions` keys that are real source paths,
  the web `buildCommand`, binding fields, and no leftover per-app `vercel.json`.
  Vercel reports most of these only at deploy time, and a wrong `functions` key
  or a missing API rewrite not at all (a real `vercel build` succeeds on both).

### Dashboard prerequisites (the Vercel docs do not spell these out)

- Root Directory is the repo root (blank), and no Install / Build / Output / Dev
  command overrides are set (build keys live in each service). A real
  `vercel build` (CLI 62.2.0) picked the services up from `vercel.json` with the
  Framework Preset unset; if the dashboard offers **Services**, select it.
- **Automatically expose System Environment Variables** stays ON. The web build
  keys its same-origin default (and skipping `output: "standalone"`) on `VERCEL=1`;
  with the setting off the browser bundle would bake in `http://localhost:4000`.
- Node.js 24.x: both services pin `"engines": { "node": "24.x" }` in their own
  `package.json` on purpose, because a real `vercel build` resolved the runtime
  (`nodejs24.x`) from each service root, not from the repo root. The root keeps
  `>=24`, which is what the repo needs; Vercel prints an "auto-upgrade to the next
  major" warning for a `>=` range, which `24.x` avoids.
- pnpm 11 (`packageManager`; the lockfile and `allowBuilds` need it). The install
  step should end with `Done ... using pnpm v11.1.1`. Vercel's own pre-selection
  line (`Using pnpm@9.x` / `pnpm@10.x ...`) can differ, because pnpm 10 switches to
  the `packageManager` version itself; only if the install ends on an older pnpm
  and fails on the lockfile, set `ENABLE_EXPERIMENTAL_COREPACK=1`.
- The `video/` project is not part of any service and is never built.

### Environment variables

Set these once, for **Production and Preview**. Vercel documents no per-service
scoping, so assume both services see every variable (INFERRED); the web service
reads none of the secrets, and only `NEXT_PUBLIC_*` is ever inlined into the
browser bundle. Full annotated list: [`.env.example`](./.env.example) and
[`apps/api/.env.example`](./apps/api/.env.example).

| Variable | Value on Vercel |
|---|---|
| `APP_URI`, `API_URI` | The one public origin, `https://<domain>`, same value for both. `APP_URI`'s **host** is the SIWE domain, so it must equal what users browse (a `*.vercel.app` host works if it is that exact host). |
| `COOKIE_DOMAIN` | **Unset.** One origin means host-only gate cookies. A value that does not domain-match the host (e.g. `.vercel.app`) is rejected by browsers and traps every visitor on `/onboarding`. |
| `NEXT_PUBLIC_API_BASE` | **Unset** (delete any value from an old two-project setup). |
| `DATABASE_URL`, `DATABASE_POOL_MAX` | Supabase pooler URL (port 6543), `DATABASE_POOL_MAX=1`. |
| `SUPABASE_JWT_SECRET` | At least 16 characters. The API refuses to start without it outside development. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Required: without them SIWE nonces, the JWT denylist and rate limits live per function instance and sign-in fails intermittently. |
| `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Required: the local storage driver cannot persist on a serverless filesystem. |
| `MAX_UPLOAD_BYTES` | Unset (defaults to `4194304` on Vercel) or at most `4194304`. Uploads stream through `PUT /api/files/:id/raw`, and Vercel Functions reject request bodies over about 4.5 MB. |
| `CRON_SECRET` | At least 16 characters; see below. |
| `CHAIN_MODE`, `CHAIN_ID`, `CHAIN_RPC_URL`, contract addresses, `INDEXER_START_BLOCK`, `ADMIN_WALLETS` | As in `.env.example`. With `CHAIN_MODE=real` on any chain but 31337, `INDEXER_START_BLOCK` must be the block the contracts were deployed at: the API refuses to load its config while it is 0. |
| `SPONSORSHIP_FORWARDER_ADDRESS`, `RELAYER_PRIVATE_KEY` | Both or neither. Mark the key Sensitive. |

Do not set `NODE_ENV` or `PORT`.

### Scheduled jobs

The in-process workers only start from `src/serve.ts`, so on Vercel nothing runs
in the background. The chain indexer, SLA scan, webhook delivery and nightly
reconcile run when `GET /api/internal/cron` is called with
`Authorization: Bearer $CRON_SECRET`. Drive it from an **external** pinger
(cron-job.org, QStash, GitHub Actions), not Vercel Cron, against the public
domain: `https://<domain>/api/internal/cron`. Those schedulers typically bottom
out at about a minute, so expect the mirror to lag the chain by that much. A
Deployment-Protected domain needs the protection-bypass header on the pinger.

### Database migrations

Migrations are not part of the Vercel build. Run `pnpm db:migrate` with the
direct (non-pooler) `DATABASE_URL` before promoting a release that adds
`apps/api/drizzle/*.sql`.

### Local development and other hosts are unchanged

`pnpm dev` still runs web and API as two processes on two origins, with the API
answering CORS preflights and `NEXT_PUBLIC_API_BASE` defaulting to
`http://localhost:4000`. The [`Caddyfile`](./Caddyfile) self-hosted layout (API on
its own origin) and the CI build (`NEXT_PUBLIC_API_BASE=http://localhost:4000`)
are untouched: an explicit `NEXT_PUBLIC_API_BASE` always wins over the Vercel
default.

`vercel dev` runs both services together locally. (INFERRED: it may not set
`VERCEL` for the Next dev server; if the browser calls `localhost:4000` under it,
start it as `NEXT_PUBLIC_API_BASE= vercel dev`, in the shell, rather than an
empty value in `.env.local`, which env tooling may drop.) The proxy's same-origin
job lookup assumes `/api/*` reaches the API through the services rewrite; on any
other single-origin setup, set `NEXT_PUBLIC_API_BASE` to the API's own URL.

### After the first deploy

Verified with `vercel build` 62.2.0 on a scratch copy (no deployment): both
services resolve, `api` builds from `src/app.ts` with `maxDuration: 60` on
`nodejs24.x`, the top-level routes are `/api/(.*)` to `api` then `/(.*)` to `web`
in that order with no crons, and no `localhost:4000` is in the web output. What
only a real deployment shows:

- `GET /api/health` returns the Hono JSON (the prefix survived the rewrite).
- Sign in with a wallet (the SIWE domain matches the host; `Set-Cookie` and
  `x-forwarded-for` pass through the rewrite, and rate limits key on the first
  `x-forwarded-for` hop).
- Upload a file under 4 MB, ping the cron route and get a 200.
- The deployed JS does not contain `localhost:4000`
  (`curl -s https://<domain>/ | grep -o '_next/static[^"]*\.js'`, then grep those).
- Open `/jobs/<uuid>` of an awarded job while signed in and get a 307 to its
  project room (the proxy's server-side lookup reaching the API).
- The web proxy does not run on `/api/*` (its matcher excludes `api/`), so a
  cookie-less sign-in call is never bounced to `/onboarding`.

Preview deployments: the SIWE message carries the `APP_URI` domain, which differs
from the preview host, so wallets may warn; and with Deployment Protection on, the
proxy's server-side awarded-job lookup is unauthenticated, fails open, and the
client-side redirect takes over.

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
- **Icons are imported per-glyph** from `pixelarticons/react/<Name>`, behind
  `components/icons.tsx` (concept → glyph), so a page never reaches into the
  package and a barrel import never drags the whole set into the dev compile.
- **SIWE gotcha**: the parser enforces strict EIP-55 checksums — anvil's
  displayed casing is NOT EIP-55, so the frontend checksums with viem's
  `getAddress()` before building the message.
- **Gateway requests removed**: the client calls `/api/**` directly
  (`apps/web/lib/api.ts`), no `?XTransformPort` rewriting. Where `/api` lives is
  decided in one place, `apps/web/lib/api-base.ts` (`NEXT_PUBLIC_API_BASE`):
  an origin means the API is cross-origin (`pnpm dev`, Caddy), the empty string
  means same-origin (Vercel services).

## Frontend design system

Pixel art on dark ink: zinc-950 base, one deep-rose accent (`#e11d48`), the
milestone-state hues as semantics only. Press Start 2P for short display
strings and controls, Pixelify Sans for UI and body copy, IBM Plex Mono for
every wei amount, hash and timestamp (mono/tabular). All three faces are
self-hosted (`apps/web/app/fonts`), so the build needs no network. Square
corners, 2px frames, offset slabs instead of shadows, dither instead of
gradients. Motion budget: a stepped landing page (scroll motion snapped to
8px, a frame-by-frame escrow card) and a calm app interior (blinking status
squares, a marching-dither skeleton). Everything moves in `steps()`, never a
spring, and `prefers-reduced-motion` is honored. Full rules in
[`DESIGN.md`](./DESIGN.md).
