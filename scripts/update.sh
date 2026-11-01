#!/usr/bin/env bash
# Update this install to the latest version on GitHub and restart it.
# Usage: npm run update      (or: bash scripts/update.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${UPDATE_BRANCH:-$(grep -E '^UPDATE_BRANCH=' .env 2>/dev/null | cut -d= -f2- || true)}"
BRANCH="${BRANCH:-main}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Files in this folder were edited by hand. Undo them first with: git checkout -- ." >&2
  exit 1
fi

before=$(git rev-parse HEAD)
git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
  git merge-base --is-ancestor HEAD "origin/$BRANCH" || { echo "Can't fast-forward to $BRANCH." >&2; exit 1; }
  echo "Switching to $BRANCH"
  git checkout -B "$BRANCH" "origin/$BRANCH"
  git branch --set-upstream-to="origin/$BRANCH" "$BRANCH"
else
  git merge --ff-only "origin/$BRANCH"
fi
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "Already up to date ($(git rev-parse --short HEAD))."
  exit 0
fi

if git diff --name-only "$before" "$after" | grep -qE '^package(-lock)?\.json$'; then
  npm ci --omit=dev --no-audit --no-fund
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart invoices
else
  npx --yes pm2 restart invoices || echo "Restart the app to finish updating."
fi
echo "Updated to $(git rev-parse --short HEAD)."
