#!/usr/bin/env bash
# Anvil end-to-end: deploy the Foundry contracts to a local chain, boot the API
# in CHAIN_MODE=real against a fresh embedded DB, and run scripts/e2e-anvil.ts
# (real wallet transactions → real indexer → mirror → RPC-verified reviews).
#
# Everything runs inside this one script (anvil + API are child processes that
# get torn down on exit) so it works in environments that reap background jobs.
set -uo pipefail
export PATH="$PATH:/home/z/.foundry/bin"

API_DIR="/home/z/my-project/mini-services/api"
CONTRACTS_DIR="/home/z/my-project/contracts"
LOGS="$API_DIR/data/logs"
RPC="http://127.0.0.1:8545"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil #0

ANVIL_PID=""
API_PID=""
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

mkdir -p "$LOGS"

echo "── 1/4 starting anvil (chain 31337, 1s blocks)"
anvil --block-time 1 --chain-id 31337 --port 8545 > "$LOGS/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 30); do
  if curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q '0x7a69'; then
    break
  fi
  sleep 0.5
done
curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q '0x7a69' \
  || { echo "anvil failed to start"; tail -5 "$LOGS/anvil.log"; exit 1; }
echo "   anvil up (pid $ANVIL_PID)"

echo "── 2/4 deploying Escrow + ArbiterRegistry"
cd "$CONTRACTS_DIR"
forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast \
  > "$LOGS/deploy.log" 2>&1 || { echo "deploy failed"; tail -20 "$LOGS/deploy.log"; exit 1; }
ESCROW=$(grep -o 'ESCROW_ADDRESS=0x[0-9a-fA-F]\{40\}' "$LOGS/deploy.log" | tail -1 | cut -d= -f2)
REGISTRY=$(grep -o 'ARBITER_REGISTRY_ADDRESS=0x[0-9a-fA-F]\{40\}' "$LOGS/deploy.log" | tail -1 | cut -d= -f2)
if [ -z "$ESCROW" ] || [ -z "$REGISTRY" ]; then
  echo "could not parse deploy addresses"; tail -20 "$LOGS/deploy.log"; exit 1
fi
echo "   escrow=$ESCROW registry=$REGISTRY"

echo "── 3/4 fresh DB + API in CHAIN_MODE=real on :3031"
cd "$API_DIR"
rm -rf data/pglite-anvil
PGLITE_DATA_DIR=./data/pglite-anvil bun src/scripts/migrate.ts > "$LOGS/migrate-anvil.log" 2>&1 \
  || { echo "migrate failed"; tail -10 "$LOGS/migrate-anvil.log"; exit 1; }
PGLITE_DATA_DIR=./data/pglite-anvil PORT=3031 CHAIN_MODE=real CHAIN_ID=31337 CHAIN_RPC_URL="$RPC" \
  ESCROW_ADDRESS="$ESCROW" ARBITER_REGISTRY_ADDRESS="$REGISTRY" \
  INDEXER_POLL_MS=1500 INDEXER_CONFIRMATIONS=1 \
  ADMIN_WALLETS=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 \
  bun src/server.ts > "$LOGS/api-anvil.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  if curl -s http://localhost:3031/health | grep -q '"ok"'; then break; fi
  sleep 0.5
done
curl -s http://localhost:3031/health | grep -q '"ok"' \
  || { echo "api failed to start"; tail -20 "$LOGS/api-anvil.log"; exit 1; }
echo "   api up (pid $API_PID)"

echo "── 4/4 running e2e (real wallet transactions)"
E2E_API=http://localhost:3031 E2E_RPC="$RPC" \
  ESCROW_ADDRESS="$ESCROW" ARBITER_REGISTRY_ADDRESS="$REGISTRY" \
  bun scripts/e2e-anvil.ts
EXIT=$?
echo "── e2e exit code: $EXIT (anvil + api logs in $LOGS)"
exit $EXIT
