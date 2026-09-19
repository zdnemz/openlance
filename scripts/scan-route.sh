#!/bin/bash
# Resilient impeccable detector scan — restarts Next when it dies mid-cycle.
# Usage: scan-route.sh <path-with-query> <out-name>
set -u
export IMPECCABLE_BROWSER=$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
cd /home/z/my-project
ROUTE="$1"
OUT="$2"

ensure_next() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/" --max-time 60)
  if [ "$code" = "200" ]; then return 0; fi
  echo "[scan] next down ($code) — restarting" >&2
  pkill -f "next dev" 2>/dev/null; pkill -f next-server 2>/dev/null; sleep 3
  if [ "$code" = "500" ]; then rm -rf .next; fi
  python3 scripts/daemonize-next.py
  local i
  for i in $(seq 1 14); do
    sleep 10
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/" --max-time 90)
    [ "$code" = "200" ] && return 0
    [ "$code" = "500" ] && { pkill -f "next dev"; pkill -f next-server; sleep 3; rm -rf .next; python3 scripts/daemonize-next.py; }
  done
  return 1
}

ensure_next || { echo "[scan] FAILED to revive next" >&2; exit 1; }

# warm the target route (compile) with generous retries
for i in 1 2 3; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$ROUTE" --max-time 150)
  [ "$CODE" = "200" ] && break
  echo "[scan] warm try$i got $CODE" >&2
  ensure_next || exit 1
done
echo "[scan] $ROUTE warmed ($CODE)" >&2

# run detector; retry once if next died during scan
for i in 1 2; do
  .claude/skills/impeccable/scripts/impeccable detect "http://localhost:3000$ROUTE" > "tool-results/$OUT.txt" 2>&1
  if ! rg -q "ERR_CONNECTION_REFUSED" "tool-results/$OUT.txt"; then
    echo "=== $ROUTE ==="
    tail -2 "tool-results/$OUT.txt"
    exit 0
  fi
  echo "[scan] detector lost next, reviving (try$i)" >&2
  ensure_next || exit 1
done
echo "[scan] giving up on $ROUTE" >&2; exit 1
