#!/usr/bin/env bash
# Update this install to the latest version and restart it.
# Uses the same update source as Updates in the app (your fork, if you chose one).
# Usage: npm run update      (or: bash scripts/update.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

out=$(node scripts/update.js) || { echo "$out"; exit 1; }
echo "$out"

if echo "$out" | grep -q '^RESTART$'; then
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart invoices
  else
    npx --yes pm2 restart invoices || echo "Restart the app to finish updating."
  fi
fi
