#!/bin/bash
# EscrowLance dev stack — ONE process tree, self-healing on sandbox boot.
#
#   anvil (:8545, chain 31337)  →  deploy Escrow+Registry  →  fresh PGlite DB
#   →  API :3030 in CHAIN_MODE=real (hot reload)  →  demo seed (real txs)
#
# Invoked by .zscripts/dev.sh via `bun run dev`. Safe to re-run: it reuses a
# live anvil, always deploys fresh contracts, and the seed is idempotent.
set -uo pipefail

cd "$(dirname "$0")/.."
API_DIR="$(pwd)"
ROOT="$(cd ../.. && pwd)"
ANVIL="${ANVIL_BIN:-$ROOT/.foundry/bin/anvil}"
[ -x "$ANVIL" ] || ANVIL="$(command -v anvil || true)"
RPC="http://127.0.0.1:8545"
mkdir -p data
log() { echo "[dev-real] $*"; }

# single-instance guard: if another orchestrator holds a live lock, stand down
if [ -f data/stack.lock ]; then
  OLD_PID="$(cat data/stack.lock 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "another stack run is live (pid $OLD_PID) — standing down"
    exit 0
  fi
fi
echo $$ > data/stack.lock
trap 'rm -f data/stack.lock' EXIT INT TERM

# ── 1. anvil up? ─────────────────────────────────────────────────────────────
rpc_ok() { curl -s -m 2 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' 2>/dev/null | grep -q '0x7a69'; }

if ! rpc_ok; then
  if [ -z "$ANVIL" ] || [ ! -x "$ANVIL" ]; then
    log "FATAL: anvil binary not found (looked in $ROOT/.foundry/bin and PATH)"
    exit 1
  fi
  log "starting anvil (chain 31337, 1s blocks)"
  mkdir -p data
  nohup "$ANVIL" --chain-id 31337 --block-time 1 --host 127.0.0.1 --port 8545 > data/anvil.log 2>&1 &
  disown $! 2>/dev/null || true
fi
for i in $(seq 1 30); do rpc_ok && break; sleep 0.5; done
rpc_ok || { log "FATAL: anvil did not come up"; exit 1; }
log "anvil ready"

# ── 2. deploy contracts (fresh every boot — anvil state resets) ─────────────
log "deploying contracts"
DEPLOY_OUT="$(bun scripts/deploy-anvil.ts 2>/dev/null | tail -1)" || { log "FATAL: deploy failed"; exit 1; }
log "deployed: $DEPLOY_OUT"
ESCROW_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"escrow":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
REGISTRY_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"arbiterRegistry":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
[ -n "$ESCROW_ADDR" ] && [ -n "$REGISTRY_ADDR" ] || { log "FATAL: could not parse deployment"; exit 1; }

# ── 3. fresh DB + env ────────────────────────────────────────────────────────
# .env FIRST (migrate reads PGLITE_DATA_DIR from it), then a wiped data dir.
cat > .env <<EOF
PORT=3030
APP_URI=http://localhost:3000
CHAIN_MODE=real
CHAIN_ID=31337
CHAIN_RPC_URL=http://127.0.0.1:8545
ESCROW_ADDRESS=$ESCROW_ADDR
ARBITER_REGISTRY_ADDRESS=$REGISTRY_ADDR
INDEXER_POLL_MS=1500
INDEXER_CONFIRMATIONS=1
PLATFORM_FEE_BPS=250
ADMIN_WALLETS=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
PGLITE_DATA_DIR=./data/pglite-anvil
EOF
log ".env written (real mode, contracts $ESCROW_ADDR / $REGISTRY_ADDR)"

rm -rf data/pglite-anvil data/pglite
log "migrating fresh PGlite DB"
bun src/scripts/migrate.ts > data/migrate.log 2>&1 || { log "FATAL: migrate failed (see data/migrate.log)"; exit 1; }

# ── 4. stop any stale API on :3030, start the real one ───────────────────────
pkill -f 'escrowlance-api' 2>/dev/null
pkill -f 'src/server.ts' 2>/dev/null
sleep 1

# Boot-safety: on a sandbox cold boot, let Next.js finish its first compile
# (memory spike) before this stack adds its footprint. No-op when Next is
# already warm or absent (local dev without the frontend).
if [ -z "${EL_NO_NEXT_WAIT:-}" ]; then
  for i in $(seq 1 240); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:3000/ 2>/dev/null || true)"
    [ "$code" = "200" ] && break
    sleep 1
  done
fi

export PORT=3030 # inherited env would override .env (the Next server exports PORT=3000)
log "starting API :3030 (CHAIN_MODE=real, hot reload)"
bun --hot src/server.ts &
API_PID=$!

for i in $(seq 1 40); do
  curl -s -m 2 http://localhost:3030/health > /dev/null 2>&1 && break
  sleep 0.5
done
curl -s -m 2 http://localhost:3030/health > /dev/null 2>&1 || { log "FATAL: API did not become healthy"; kill $API_PID; exit 1; }
log "API healthy"

# ── 5. demo seed (idempotent, ~90s of real txs) — background, non-fatal ──────
log "seeding demo data (background)"
(bun scripts/seed-real.ts > data/seed.log 2>&1; ec=$?; if [ $ec -eq 0 ]; then log "seed complete"; else log "seed failed (see data/seed.log)"; fi) &
disown $! 2>/dev/null || true

log "stack up — anvil :8545, api :3030, seed running"
wait $API_PID
