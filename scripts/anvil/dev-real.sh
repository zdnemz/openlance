#!/bin/bash
# OpenLance dev chain stack — anvil + contracts + real-chain seed.
#
#   anvil (:8545, chain 31337)  →  deploy Escrow+Registry  →  write contract
#   addresses to .env.local  →  migrate Supabase Postgres  →  demo seed (real txs)
#
# The API itself now runs INSIDE the Next.js server (route handlers under
# /api) — this script does not start or babysit a separate API process. It is
# invoked by the /api/dev/stack route or manually: `bash scripts/anvil/dev-real.sh`.
#
# Safe to re-run: it reuses a live anvil, always deploys fresh contracts, and
# the seed is idempotent.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
mkdir -p "$HERE/.state"
ANVIL="${ANVIL_BIN:-$ROOT/.foundry/bin/anvil}"
[ -x "$ANVIL" ] || ANVIL="$(command -v anvil || true)"
RPC="http://127.0.0.1:8545"
log() { echo "[dev-real] $*"; }

# single-instance guard: if another orchestrator holds a live lock, stand down
LOCK="$HERE/.state/stack.lock"
if [ -f "$LOCK" ]; then
  OLD_PID="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "another stack run is live (pid $OLD_PID) — standing down"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# ── 1. anvil up? ─────────────────────────────────────────────────────────────
rpc_ok() { curl -s -m 2 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' 2>/dev/null | grep -q '0x7a69'; }

if ! rpc_ok; then
  if [ -z "$ANVIL" ] || [ ! -x "$ANVIL" ]; then
    log "FATAL: anvil binary not found (looked in $ROOT/.foundry/bin and PATH)"
    exit 1
  fi
  log "starting anvil (chain 31337, 1s blocks)"
  nohup "$ANVIL" --chain-id 31337 --block-time 1 --host 127.0.0.1 --port 8545 > "$HERE/.state/anvil.log" 2>&1 &
  disown $! 2>/dev/null || true
fi
for i in $(seq 1 30); do rpc_ok && break; sleep 0.5; done
rpc_ok || { log "FATAL: anvil did not come up"; exit 1; }
log "anvil ready"

# ── 2. deploy contracts (fresh every boot — anvil state resets) ─────────────
log "building contracts (hardhat)"
(cd "$ROOT/contracts" && npx hardhat build) > "$HERE/.state/build.log" 2>&1 || { log "FATAL: contract build failed (see $HERE/.state/build.log)"; exit 1; }

log "deploying contracts"
DEPLOY_OUT="$(bun "$HERE/deploy-anvil.ts" 2>/dev/null | tail -1)" || { log "FATAL: deploy failed"; exit 1; }
log "deployed: $DEPLOY_OUT"
ESCROW_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"escrow":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
REGISTRY_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"arbiterRegistry":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
TIMELOCK_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"timelock":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
[ -n "$ESCROW_ADDR" ] && [ -n "$REGISTRY_ADDR" ] || { log "FATAL: could not parse deployment"; exit 1; }

# ── 3. write the resolved chain config into .env.local (Next reads it) ──────
# Preserve an existing DATABASE_URL/Upstash/Supabase config; only replace the
# chain-specific keys.
ENV_FILE="$ROOT/.env.local"
touch "$ENV_FILE"
strip_keys() { grep -vE "^(CHAIN_MODE|CHAIN_ID|CHAIN_RPC_URL|ESCROW_ADDRESS|ARBITER_REGISTRY_ADDRESS|TIMELOCK_ADDRESS|INDEXER_POLL_MS|INDEXER_CONFIRMATIONS|PLATFORM_FEE_BPS|ADMIN_WALLETS)=" "$ENV_FILE" 2>/dev/null || true; }
strip_keys > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
CHAIN_MODE=real
CHAIN_ID=31337
CHAIN_RPC_URL=http://127.0.0.1:8545
ESCROW_ADDRESS=$ESCROW_ADDR
ARBITER_REGISTRY_ADDRESS=$REGISTRY_ADDR
TIMELOCK_ADDRESS=$TIMELOCK_ADDR
INDEXER_POLL_MS=1500
INDEXER_CONFIRMATIONS=1
PLATFORM_FEE_BPS=250
ADMIN_WALLETS=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
EOF
log ".env.local updated (real mode, contracts $ESCROW_ADDR / $REGISTRY_ADDR)"
log "NOTE: restart the Next.js dev server to pick up env changes"

# ── 4. migrate the configured database ──────────────────────────────────────
log "applying migrations"
bun "$ROOT/scripts/migrate.ts" > "$HERE/.state/migrate.log" 2>&1 || { log "FATAL: migrate failed (see $HERE/.state/migrate.log)"; exit 1; }

# ── 5. demo seed (idempotent, ~90s of real txs) — background, non-fatal ──────
log "seeding demo data (background)"
(bun "$HERE/seed-real.ts" > "$HERE/.state/seed.log" 2>&1; ec=$?; if [ $ec -eq 0 ]; then log "seed complete"; else log "seed failed (see $HERE/.state/seed.log)"; fi) &
disown $! 2>/dev/null || true

log "chain stack up — anvil :8545, contracts deployed, seed running; API is served by Next.js on :3000"
