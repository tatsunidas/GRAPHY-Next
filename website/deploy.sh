#!/usr/bin/env bash
#
# Deploy the built static site to graphy.vis-ionary.com on Xserver.
#
# Static output (dist/) is rsynced to the subdomain docroot. Run from a
# Japan IP (this repo's dev machine) so Xserver's overseas-IP block does not
# apply. Requires the deploy SSH key.
#
# Usage:
#   npm run build && bash deploy.sh
#   bash deploy.sh --dry-run
#
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/xserver_deploy}"
SSH_PORT="${SSH_PORT:-10022}"
SSH_HOST="${SSH_HOST:-tatsunidas76@sv17120.xserver.jp}"
DOCROOT="${DOCROOT:-/home/tatsunidas76/vis-ionary.com/public_html/graphy.vis-ionary.com}"

DIST="$(cd "$(dirname "$0")" && pwd)/dist"

if [[ ! -d "$DIST" ]]; then
  echo "dist/ not found. Run 'npm run build' first." >&2
  exit 1
fi

DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

echo "[deploy] $DIST -> $SSH_HOST:$DOCROOT ${DRY}"
rsync -az --delete $DRY \
  --exclude 'graphy-data/' \
  -e "ssh -i $SSH_KEY -p $SSH_PORT -o IdentitiesOnly=yes" \
  "$DIST"/ "$SSH_HOST:$DOCROOT/"

echo "[deploy] done. https://graphy.vis-ionary.com/"
