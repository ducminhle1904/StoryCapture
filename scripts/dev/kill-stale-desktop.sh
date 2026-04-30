#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dev_binary="${repo_root}/target/debug/storycapture"

pids=()
while IFS= read -r pid; do
  if [ -n "$pid" ]; then
    pids+=("$pid")
  fi
done < <(
  ps -axo pid=,command= |
    awk -v bin="${dev_binary}" -v self="$$" '
      {
        pid = $1
        $1 = ""
        sub(/^ +/, "", $0)
        if (pid != self && index($0, bin) > 0) {
          print pid
        }
      }
    '
)

if [ "${#pids[@]}" -eq 0 ]; then
  echo "storycapture dev preflight: no stale native process"
  exit 0
fi

echo "storycapture dev preflight: stopping stale native process(es): ${pids[*]}"
kill -TERM "${pids[@]}" 2>/dev/null || true

deadline=$((SECONDS + 5))
while [ "$SECONDS" -lt "$deadline" ]; do
  alive=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive+=("$pid")
    fi
  done
  if [ "${#alive[@]}" -eq 0 ]; then
    echo "storycapture dev preflight: stale native process stopped"
    exit 0
  fi
  sleep 0.2
done

echo "storycapture dev preflight: force stopping stale native process(es): ${alive[*]}"
kill -KILL "${alive[@]}" 2>/dev/null || true
