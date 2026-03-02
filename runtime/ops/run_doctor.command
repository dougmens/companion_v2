#!/bin/zsh
set -euo pipefail

ROOT="$HOME/Documents/Companion"
cd "$ROOT"

mkdir -p runtime/ops
STAMP_FILE="runtime/ops/last_full_doctor.stamp"
FULL_INTERVAL_SEC=$((7 * 24 * 60 * 60))

printf "[doctor] quick run started\n"
npm run system:doctor:quick

NEED_FULL=0
if [ ! -f "$STAMP_FILE" ]; then
  NEED_FULL=1
else
  NOW_EPOCH=$(date +%s)
  LAST_EPOCH=$(stat -f %m "$STAMP_FILE" 2>/dev/null || echo 0)
  if [ $((NOW_EPOCH - LAST_EPOCH)) -ge "$FULL_INTERVAL_SEC" ]; then
    NEED_FULL=1
  fi
fi

if [ "$NEED_FULL" -eq 1 ]; then
  printf "[doctor] weekly full run started\n"
  npm run system:doctor:full
  touch "$STAMP_FILE"
fi

printf "[doctor] done\n"
