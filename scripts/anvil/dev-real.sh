#!/bin/bash
# OpenLance dev chain stack — anvil + contracts, no seed data (fresh boot).
#
#   anvil (:8545, chain 31337)  →  deploy Escrow+Registry  →  write contract
#   addresses to .env.local  →  migrate Supabase Postgres
#
# This script does NOT start the app. The API is a separate service now
# (apps/api on :4000) and the web app is apps/web on :3000; run `pnpm dev` for
# those. This is the chain layer only — anvil is the local node, NOT
# `hardhat node`, which would fight it for port 8545.
#
# Invoked by POST /api/dev/stack or manually:
#   bash scripts/anvil/dev-real.sh
#
# Safe to re-run: it reuses a live anvil and always deploys fresh contracts.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
mkdir -p "$HERE/.state"
ANVIL="${ANVIL_BIN:-}"
# ANVIL_BIN wins, then a repo-local install, then foundryup's ~/.foundry/bin
# (the default install dir, which PATH omits in non-interactive shells), then PATH.
for c in "$ROOT/.foundry/bin/anvil" "$HOME/.foundry/bin/anvil" "$(command -v anvil || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { ANVIL="$c"; break; }
done
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
    log "FATAL: anvil binary not found (set ANVIL_BIN, or looked in $ROOT/.foundry/bin, $HOME/.foundry/bin, PATH)"
    exit 1
  fi
  log "starting anvil (chain 31337, 1s blocks)"
  nohup "$ANVIL" --chain-id 31337 --block-time 1 --host 127.0.0.1 --port 8545 > "$HERE/.state/anvil.log" 2>&1 &
  disown $! 2>/dev/null || true
fi
for i in $(seq 1 30); do rpc_ok && break; sleep 0.5; done
rpc_ok || { log "FATAL: anvil did not come up"; exit 1; }
log "anvil ready"

# ── 1b. fund the server relayer (gasless sponsorship) ───────────────────────
# The API's relayer signs `registerSession` + `execute` on the forwarder and
# fronts the action's `value`, so it needs ETH before ANY sponsored click can
# work. Left unfunded it fails as a bare 500 ("insufficient funds") from a
# zero-balance key. Dev-only: on a real chain you fund it with real ETH.
RELAYER_KEY="$(grep -m1 '^RELAYER_PRIVATE_KEY=' "$ROOT/.env.local" 2>/dev/null | cut -d= -f2-)"
if [ -z "$RELAYER_KEY" ]; then
  log "no RELAYER_PRIVATE_KEY — skipping relayer funding (sponsorship off)"
else
  # Derive the address with the API's own viem rather than trusting a hardcoded
  # one: the key is what decides, and this key rotates.
  RELAYER_ADDR="$(cd "$ROOT/apps/api" && node -e "console.log(require('viem/accounts').privateKeyToAccount(process.argv[1]).address)" "$RELAYER_KEY" 2>/dev/null)"
  if [ -z "$RELAYER_ADDR" ]; then
    log "WARN: could not derive an address from RELAYER_PRIVATE_KEY — sponsored actions will fail"
  else
    # 1000 ETH: anvil gas is free, but the relayer also pays each action's
    # `value` (e.g. a 0.05 ETH dispute fee) on the user's behalf.
    curl -s -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"anvil_setBalance\",\"params\":[\"$RELAYER_ADDR\",\"0x3635c9adc5dea00000\"]}" >/dev/null
    log "relayer funded: $RELAYER_ADDR"
  fi
fi

# ── 2. deploy contracts (fresh every boot — anvil state resets) ─────────────
log "building contracts (hardhat)"
(cd "$ROOT/apps/contracts" && pnpm exec hardhat build) > "$HERE/.state/build.log" 2>&1 || { log "FATAL: contract build failed (see $HERE/.state/build.log)"; exit 1; }

log "deploying contracts"
# Deploy lives in apps/contracts (it needs that package's viem + Hardhat config).
# Capture the log instead of discarding it: a silent `2>/dev/null` turns a
# missing-dependency error into a bare "deploy failed".
(cd "$ROOT/apps/contracts" && pnpm exec tsx scripts/deploy-anvil.ts) > "$HERE/.state/deploy.log" 2>&1 || {
  log "FATAL: deploy failed (see $HERE/.state/deploy.log)"; tail -5 "$HERE/.state/deploy.log"; exit 1;
}
DEPLOY_OUT="$(tail -1 "$HERE/.state/deploy.log")"
log "deployed: $DEPLOY_OUT"
ESCROW_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"escrow":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
REGISTRY_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"arbiterRegistry":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
TIMELOCK_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"timelock":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
FWD_ADDR="$(echo "$DEPLOY_OUT" | sed -n 's/.*"sponsorshipForwarder":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
[ -n "$ESCROW_ADDR" ] && [ -n "$REGISTRY_ADDR" ] || { log "FATAL: could not parse deployment"; exit 1; }
[ -n "$FWD_ADDR" ] || { log "FATAL: deployment has no sponsorshipForwarder — gasless would point at a stale address"; exit 1; }

# ── 2b. seed the arbiter roster ─────────────────────────────────────────────
# A fresh deploy starts with an EMPTY roster. Disputes need at least one
# eligible arbiter, and a thin panel is a degraded single-vote round, so a
# brand-new devnet could not exercise the multi-arbiter path at all. Seed two
# (the 2-of-3 panel) so the normal flow is reachable out of the box.
#
# Dev-only: on a real network arbiters earn their place by staking real ETH.
# 0.1 ETH each = the registry's minStake.
log "seeding 2 arbiters"
# Anvil's deterministic public test accounts #2 and #3 (10000 ETH each, never
# real value). Anvil only auto-signs for account #0, so these are impersonated
# for the seed tx and released again right after.
for ADDR in 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0x90F79bf6EB2c4f870365E785982E1f101E93b906; do
  curl -s -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"anvil_impersonateAccount\",\"params\":[\"$ADDR\"]}" >/dev/null
  RES="$(curl -s -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendTransaction\",\"params\":[{\"from\":\"$ADDR\",\"to\":\"$REGISTRY_ADDR\",\"data\":\"0x2fa92ccb\",\"value\":\"0x16345785d8a0000\"}]}")"
  curl -s -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"anvil_stopImpersonatingAccount\",\"params\":[\"$ADDR\"]}" >/dev/null
  case "$RES" in
    *'"result"'*) : ;;
    *) log "FATAL: arbiter seed tx for $ADDR failed: $RES"; exit 1 ;;
  esac
done
# minStakeDuration is 60s on local, so a freshly registered arbiter is not
# selectable until the clock passes. Wait it out — otherwise the roster reads
# as empty and the first dispute opens degraded for the wrong reason.
log "waiting out minStakeDuration"
sleep 62
log "arbiters seeded (2 on the roster)"

# ── 2c. fund the protocol reward pool ───────────────────────────────────────
# Disputes are free (disputeFee = 0), so the arbiters' pot is drawn from
# `rewardPool` instead of from the opener. A devnet starts with an empty pool,
# which is safe (arbiters fall back to the milestone fee) but hides the intended
# behaviour — so fund enough for a few rounds. Dev-only: on a real network the
# protocol funds this from its own revenue via `depositRewards()`.
log "funding the reward pool"
POOL_RES="$(curl -s -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendTransaction\",\"params\":[{\"from\":\"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\",\"to\":\"$ESCROW_ADDR\",\"data\":\"0x152111f7\",\"value\":\"0x4563918244f40000\"}]}")"
case "$POOL_RES" in
  *'"result"'*) log "reward pool funded (5 ETH)" ;;
  *) log "WARN: could not fund the reward pool ($POOL_RES) — arbiters will earn only the milestone fee" ;;
esac

# ── 3. write the resolved chain config into .env.local (Next reads it) ──────
# Preserve an existing DATABASE_URL/Upstash/Supabase config; only replace the
# chain-specific keys. The publish deposit locks into the Escrow contract
# directly (lockBudget), so no separate custody address is written here.
#
# The forwarder address MUST be rewritten on every deploy: it is a fresh
# contract each time, Escrow/Registry were initialized to trust exactly that
# one, and a stale value makes every sponsored action revert NotParty().
CHAIN_ENV_KEYS="CHAIN_MODE|CHAIN_ID|CHAIN_RPC_URL|ESCROW_ADDRESS|ARBITER_REGISTRY_ADDRESS|TIMELOCK_ADDRESS|SPONSORSHIP_FORWARDER_ADDRESS|INDEXER_POLL_MS|INDEXER_CONFIRMATIONS|PLATFORM_FEE_BPS|ADMIN_WALLETS"
write_chain_env() {
  ENV_FILE="$1"
  touch "$ENV_FILE"
  grep -vE "^($CHAIN_ENV_KEYS)=" "$ENV_FILE" 2>/dev/null > "$ENV_FILE.tmp" || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  cat >> "$ENV_FILE" <<EOF
CHAIN_MODE=real
CHAIN_ID=31337
CHAIN_RPC_URL=http://127.0.0.1:8545
ESCROW_ADDRESS=$ESCROW_ADDR
ARBITER_REGISTRY_ADDRESS=$REGISTRY_ADDR
TIMELOCK_ADDRESS=$TIMELOCK_ADDR
SPONSORSHIP_FORWARDER_ADDRESS=$FWD_ADDR
INDEXER_POLL_MS=1500
INDEXER_CONFIRMATIONS=1
PLATFORM_FEE_BPS=250
ADMIN_WALLETS=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
EOF
}

# The root file is the one Next reads; apps/api/.env.local is a real file here
# (postinstall's link-env.mjs leaves deliberate overrides alone) and is the one
# the API actually loads. Both get the chain block — write only the root and the
# API keeps a stale forwarder, so every sponsored action reverts.
write_chain_env "$ROOT/.env.local"
[ -f "$ROOT/apps/api/.env.local" ] && write_chain_env "$ROOT/apps/api/.env.local"
log "env updated (real mode, contracts $ESCROW_ADDR / $REGISTRY_ADDR, forwarder $FWD_ADDR)"
log "NOTE: restart the API service to pick up the new env values"

# ── 4. sync the schema to the configured database (env DATABASE_URL) ───────
log "pushing schema"
(cd "$ROOT/apps/api" && pnpm db:migrate) > "$HERE/.state/migrate.log" 2>&1 || { log "FATAL: push failed (see $HERE/.state/migrate.log)"; exit 1; }

log "chain stack up — anvil :8545, fresh contracts deployed, empty DB"
log "start the app with: pnpm dev   (web :3000, api :4000)"
