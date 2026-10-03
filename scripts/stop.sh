#!/bin/bash
# Stop every background service this project runs:
#
#   anvil :8545  (started by scripts/anvil/dev-real.sh, nohup'd + disowned)
#   api   :12322 (pnpm dev:api  → node --watch src/serve.ts)
#   web   :12321 (pnpm dev:web  → next dev)
#
#   pnpm stop        # or: bash scripts/stop.sh
#
# Two rules, both about not killing something that isn't ours:
#   1. Ports come from .env.local (CHAIN_RPC_URL / PORT / APP_URI), so the list
#      can never drift from the app config.
#   2. A process is only a target if it holds one of those ports. `fuser`
#      rather than `lsof` — lsof misses `next-server` here (it reads /proc fd
#      links the Next dev supervisor does not expose); fuser asks the kernel.
# Remote services (hosted Supabase Postgres, Upstash Redis) are untouched.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

env_port() { grep -m1 "^$1=" .env.local 2>/dev/null | cut -d= -f2- | sed -E 's|.*:([0-9]+).*|\1|'; }
PORTS=(
  "$(env_port CHAIN_RPC_URL || true)"
  "$(env_port PORT || true)"
  "$(grep -m1 '^APP_URI=' .env.local 2>/dev/null | sed -E 's|.*:([0-9]+).*|\1|')"
)
PORTS=(${PORTS[0]:-8545} ${PORTS[1]:-4000} ${PORTS[2]:-3000})

pids_on() { fuser -n tcp "$1" 2>/dev/null | tr -s ' \n' ' '; }

# Kill the port owner, then walk up its ancestors for as long as they live
# inside this repo (the pnpm / `next dev` wrappers that would otherwise linger
# and, for `node --watch`, could outlive the server). Stops at the first
# ancestor outside the repo, so the user's terminal and any other project on
# this box (there is one on :20128) are never touched.
kill_tree() {
  local pid="$1" cwd
  while [ -n "${pid:-}" ] && [ "$pid" != "1" ] && [ -d "/proc/$pid" ]; do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "${cwd:-}" in "$ROOT" | "$ROOT"/*) kill "$pid" 2>/dev/null ;; *) return ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
}

# The stack script is not an ancestor of anvil (anvil is nohup'd + disowned),
# but the API dev route can leave one mid-deploy, holding the chain lock.
pkill -f "$ROOT/scripts/anvil/dev-real.sh" 2>/dev/null && echo "stopped anvil stack script"

for port in "${PORTS[@]}"; do
  for pid in $(pids_on "$port"); do kill_tree "$pid"; done
  pids="$(pids_on "$port")"
  [ -n "$pids" ] || { echo ":$port stopped"; continue; }
  echo "stopping :$port (pid $pids)"
  kill $pids 2>/dev/null
done

# Anything still holding a port after ~3s is wedged and needs SIGKILL.
for _ in $(seq 1 15); do
  busy=0
  for port in "${PORTS[@]}"; do [ -n "$(pids_on "$port")" ] && busy=1; done
  [ "$busy" -eq 0 ] && break
  sleep 0.2
done
for port in "${PORTS[@]}"; do
  pids="$(pids_on "$port")"
  [ -n "$pids" ] || continue
  echo "force killing :$port (pid $pids)"
  kill -9 $pids 2>/dev/null
done

echo "stopped: all openlance background services"
