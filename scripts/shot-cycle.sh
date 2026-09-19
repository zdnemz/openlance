#!/bin/bash
# Hard-reset Next, then take one screenshot. Usage: shot-cycle.sh <name> <url> <w> <h>
set -u
cd /home/z/my-project
NAME="$1"; URL="$2"; W="$3"; H="$4"
pkill -9 -f "next dev" 2>/dev/null; pkill -9 -f next-server 2>/dev/null; sleep 4
rm -rf .next; sleep 1
python3 scripts/daemonize-next.py
for i in $(seq 1 20); do
  sleep 12
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 90)
  [ "$CODE" = "200" ] && break
  [ "$CODE" = "500" ] && { pkill -9 -f "next dev"; pkill -9 -f next-server; sleep 4; rm -rf .next; python3 scripts/daemonize-next.py; }
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 90)
if [ "$CODE" != "200" ]; then echo "$NAME: server failed ($CODE)"; exit 1; fi
# warm target
curl -s -o /dev/null --max-time 150 "$URL" || true
npx tsx scripts/shot-one.ts "$NAME" "$URL" "$W" "$H" 2>&1 | tail -1
