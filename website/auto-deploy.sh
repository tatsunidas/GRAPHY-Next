#!/usr/bin/env bash
#
# GRAPHY website auto-deploy (dev-machine cron).
#
# The download pages bake the *latest GitHub release* URLs into static HTML at
# build time, so a new release only appears on graphy.vis-ionary.com after a
# rebuild + redeploy. This script watches both product repos for a change in
# their latest-release tag and, when one changes, rebuilds the Astro site and
# deploys it via deploy.sh.
#
# Why the dev machine (not GitHub Actions): deploy.sh rsyncs to Xserver, which
# blocks overseas IPs, and Astro needs Node to build. Only this machine has a
# Japan IP + the deploy SSH key + Node. Cron fires while the machine is on and
# safely catches up (no-op when nothing changed).
#
#   Manual:  bash auto-deploy.sh           # deploy only if a release changed
#            bash auto-deploy.sh --force    # rebuild + deploy regardless
#   Cron:    */30 * * * * /home/tatsunidas/graphy-workspace/GRAPHY-Next/website/auto-deploy.sh >/dev/null 2>&1
#
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$HERE"

# cron has a minimal PATH and no nvm; make node/npm resolvable.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[[ -n "$NODE_BIN" ]] && export PATH="$NODE_BIN:$PATH"

STATE="$HERE/.deploy-state"
LOG_DIR="$HERE/log"
LOG="$LOG_DIR/auto-deploy.log"
mkdir -p "$LOG_DIR"

log() { echo "[auto-deploy] $(date '+%F %T') $*" | tee -a "$LOG"; }

# Repos to watch — must match `repos` in src/data/site.ts.
REPOS=( "tatsunidas/GRAPHY-Next" "tatsunidas/GRAPHY" )

# Single-instance guard (cron + manual runs can overlap otherwise).
exec 9>"/tmp/graphy-website-auto-deploy.lock" || true
if command -v flock >/dev/null 2>&1; then
    flock -n 9 || { log "another run is in progress; skip"; exit 0; }
fi

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# Resolve the latest release tag for a repo (empty on any failure).
gh_latest() {
    local repo="$1"
    curl -fsSL \
        -H 'Accept: application/vnd.github+json' \
        ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
        "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null \
        | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]*)".*/\1/'
}

CURRENT=""
for r in "${REPOS[@]}"; do
    tag="$(gh_latest "$r" || true)"
    if [[ -z "$tag" ]]; then
        # Don't advance state on a transient API failure; just retry next run.
        log "WARN: could not resolve latest release for $r; skip this run"
        exit 0
    fi
    CURRENT+="$r=$tag "
done
CURRENT="${CURRENT% }"

PREV=""
[[ -f "$STATE" ]] && PREV="$(cat "$STATE")"

if [[ "$FORCE" -eq 0 && "$CURRENT" == "$PREV" ]]; then
    log "no release change ($CURRENT); skip"
    exit 0
fi

log "release change detected"
log "  was: ${PREV:-<none>}"
log "  now: $CURRENT"

log "building..."
npm run build >>"$LOG" 2>&1

log "deploying..."
bash "$HERE/deploy.sh" >>"$LOG" 2>&1

# Record only after a successful build + deploy, so a failure retries next run.
echo "$CURRENT" > "$STATE"
log "done: deployed $CURRENT"
