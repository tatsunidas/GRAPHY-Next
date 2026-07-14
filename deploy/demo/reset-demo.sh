#!/usr/bin/env bash
# 公開デモを毎晩0:00にゴールデンスナップショットへリストアする。
#
# 対象: deploy/demo/data/（dcm4chee: ldap/db/storage/wildfly）＋
#       demo_graphy_backend_data ボリューム（graphy-backend の H2 DB。レポート/設定/匿名化マスク）。
# 除外: cloudflared（トンネル接続を維持したまま、リストア中は502を返す程度に留める）。
#
# ゴールデンスナップショットの場所・取得方法は fw/web-demo-hosting.md の
# 「通信量制限」節と同じセクション（夜間リセット）を参照。
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"
SNAPSHOT_DIR="$HOME/graphy-demo-golden-snapshot"
LOG_FILE="$HOME/graphy-demo-golden-snapshot/reset.log"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

if [ ! -d "$SNAPSHOT_DIR/data" ] || [ ! -d "$SNAPSHOT_DIR/graphy_backend_data" ]; then
  log "ERROR: snapshot not found at $SNAPSHOT_DIR, aborting"
  exit 1
fi

log "reset start"

docker compose -f "$COMPOSE_FILE" stop ldap db arc graphy-backend >> "$LOG_FILE" 2>&1

DATA_DIR="$(dirname "$COMPOSE_FILE")/data"
docker run --rm \
  -v "$DATA_DIR":/dst \
  -v "$SNAPSHOT_DIR/data":/src:ro \
  alpine sh -c "rm -rf /dst/* && cp -a /src/. /dst/" >> "$LOG_FILE" 2>&1

docker run --rm \
  -v demo_graphy_backend_data:/dst \
  -v "$SNAPSHOT_DIR/graphy_backend_data":/src:ro \
  alpine sh -c "rm -rf /dst/* && cp -a /src/. /dst/" >> "$LOG_FILE" 2>&1

docker compose -f "$COMPOSE_FILE" start ldap db arc graphy-backend >> "$LOG_FILE" 2>&1

log "reset done"
