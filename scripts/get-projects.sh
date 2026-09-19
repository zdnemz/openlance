#!/bin/bash
# Mint a SIWE session for persona 0 (Mara) and list her projects (to get project IDs)
set -e
BASE=http://localhost:3030
CAST=/home/z/my-project/.foundry/bin/cast
NONCE_RESP=$(curl -s "$BASE/auth/nonce")
NONCE=$(echo "$NONCE_RESP" | jq -r '.data.nonce')
DOMAIN=$(echo "$NONCE_RESP" | jq -r '.data.siwe.domain')
CHAIN=$(echo "$NONCE_RESP" | jq -r '.data.siwe.chainId')
STATEMENT=$(echo "$NONCE_RESP" | jq -r '.data.siwe.statement')
ADDR=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ISSUED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
EXPIRES=$(date -u -d "+10 minutes" +%Y-%m-%dT%H:%M:%S.000Z)
URI=http://$DOMAIN
MSG="$DOMAIN wants you to sign in with your Ethereum account:
$ADDR

$STATEMENT

URI: $URI
Version: 1
Chain ID: $CHAIN
Nonce: $NONCE
Issued At: $ISSUED
Expiration Time: $EXPIRES"
SIG=$($CAST wallet sign --private-key $KEY "$(printf '%s' "$MSG")")
PAYLOAD=$(jq -n --arg m "$MSG" --arg s "$SIG" '{message:$m,signature:$s}')
VERIFY=$(curl -s -X POST "$BASE/auth/verify" -H 'content-type: application/json' -d "$PAYLOAD")
TOKEN=$(echo "$VERIFY" | jq -r '.data.token // empty')
if [ -z "$TOKEN" ]; then echo "VERIFY FAILED: $VERIFY"; exit 1; fi
echo "TOKEN_OK"
curl -s "$BASE/projects" -H "authorization: Bearer $TOKEN" | jq -r '.data.items[] | .id + "  |  " + (.title // "?") + "  |  " + .status'
