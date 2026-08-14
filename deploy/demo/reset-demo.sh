#!/usr/bin/env bash
# 公開デモを毎晩0:00にゴールデンスナップショットへリストアし、あわせて main の最新版へ
# 更新する（origin/main を ff-only で取り込み → graphy-backend を再ビルド → 差し替え）。
#
# 更新はリストアより前・コンテナ稼働中に行う。ビルドは数分かかることがあり、先に止めると
# その間ずっとデモが落ちるため。更新に失敗した場合は現行イメージのまま素通りし、リストアだけ
# 続行する（デモが古いのは許容できるが、止まるのは許容できない）。
#
# 対象: deploy/demo/data/（dcm4chee: ldap/db/storage/wildfly）＋
#       demo_graphy_backend_data ボリューム（graphy-backend の H2 DB。レポート/設定/匿名化マスク）。
# 除外: cloudflared（トンネル接続を維持したまま、リストア中は502を返す程度に留める）。
#       demo_graphy_subscriber_data ボリューム（お知らせメール登録者。★下記）。
#
# ゴールデンスナップショットの場所・取得方法は fw/web-demo-hosting.md の
# 「通信量制限」節と同じセクション（夜間リセット）を参照。
#
# ★ お知らせメール登録者について
#   このスクリプト（2026-07-14 導入）より後にメーリングリスト（2026-07-16）が追加され、
#   登録者テーブルがアプリ本体のH2に同居していたため、日中の登録が毎晩ここで消えていた。
#   現在は登録者だけを別ボリューム（/app/subscribers）へ分離してあり、このスクリプトは
#   そちらを一切触らない。念のため保険として、リストア前にCSVへ退避だけしておく
#   （$HOME/graphy-demo-subscribers/ に世代で残る）。退避に失敗してもリストアは続行する
#   ——登録者はもうリセットの影響を受けないため、退避失敗を理由にデモのリセットを
#   止めてしまう方が有害。経緯は MailingListSubscriberRepository のクラスコメント参照。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SNAPSHOT_DIR="$HOME/graphy-demo-golden-snapshot"
LOG_FILE="$HOME/graphy-demo-golden-snapshot/reset.log"

SUBSCRIBER_BACKUP_DIR="$HOME/graphy-demo-subscribers"
SUBSCRIBER_BACKUP_KEEP=60

# shellcheck source=./lib-h2.sh
source "$SCRIPT_DIR/lib-h2.sh"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

# 保険の退避。失敗しても警告のみ（リストアは続行する）。
backup_subscribers() {
  local out status
  mkdir -p "$SUBSCRIBER_BACKUP_DIR"
  out="$SUBSCRIBER_BACKUP_DIR/subscribers-$(date +%Y%m%d-%H%M%S).csv"

  set +e
  h2_export_csv "$SUBSCRIBER_DB_URL" \
    "SELECT EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT FROM MAILING_LIST_SUBSCRIBER" "$out"
  status=$?
  set -e

  case "$status" in
    0) log "  subscribers: $(($(wc -l < "$out") - 1)) 件を退避 → $out" ;;
    2)
      rm -f "$out"
      log "  WARN: subscribers: テーブル未作成のため退避なし（登録者0件）"
      ;;
    *)
      rm -f "$out"
      log "  WARN: subscribers: 退避に失敗（リストアは続行。登録者DBはリセット対象外なので消えません）"
      log "  H2出力: ${H2_LAST_ERROR:-}"
      ;;
  esac

  # 世代を絞る（復旧の当てにできる程度には残す）。
  ls -1t "$SUBSCRIBER_BACKUP_DIR"/subscribers-*.csv 2>/dev/null \
    | tail -n +$((SUBSCRIBER_BACKUP_KEEP + 1)) \
    | xargs -r rm -f
}

# origin/main の最新版を取り込んで graphy-backend イメージを焼き直す。
# 失敗しても呼び出し側は止めない（現行イメージのまま夜間リストアだけ続ける）。
#
# Docker のビルドコンテキストは git の ref ではなく作業ツリーそのもの。つまりここで
# チェックアウトされている中身がそのままデモに出る。よって:
#   - 作業ツリーが汚れていたら更新しない（人が編集中のものを公開してしまう／
#     ff-only が失敗して中途半端になる）
#   - ff-only だけ。reset --hard や force pull で人の作業を消さない
update_to_latest() {
  local before after

  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    log "  WARN: 作業ツリーに未コミットの変更があるため更新を見送り（現行イメージのまま）"
    return
  fi

  if ! git -C "$REPO_ROOT" fetch origin main --quiet >> "$LOG_FILE" 2>&1; then
    log "  WARN: git fetch に失敗（現行イメージのまま）"
    return
  fi

  before="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  after="$(git -C "$REPO_ROOT" rev-parse --short origin/main)"
  if [ "$before" = "$after" ]; then
    log "  update: 既に最新（$before）"
    return
  fi

  if ! git -C "$REPO_ROOT" merge --ff-only origin/main >> "$LOG_FILE" 2>&1; then
    log "  WARN: ff-only merge に失敗（$before → $after）。現行イメージのまま"
    return
  fi
  log "  update: $before → $after、イメージを再ビルドする"

  # ビルド失敗時は直前のイメージがそのまま残る（タグは付け替えられない）ので、
  # 壊れた版が公開されることはない。次の晩に再挑戦される。
  if ! docker compose -f "$COMPOSE_FILE" build graphy-backend >> "$LOG_FILE" 2>&1; then
    log "  ERROR: イメージのビルドに失敗。現行イメージのまま続行する"
    return
  fi
  log "  update: ビルド完了"
}

# 別マシン（開発用Linux機・Windows等）に誤って cron を複製された場合の安全装置。
# 詳細: deploy/demo/check-server-identity.sh
if ! "$SCRIPT_DIR/check-server-identity.sh" >> "$LOG_FILE" 2>&1; then
  log "ERROR: server identity check failed, aborting (see check-server-identity.sh output above)"
  exit 1
fi

if [ ! -d "$SNAPSHOT_DIR/data" ] || [ ! -d "$SNAPSHOT_DIR/graphy_backend_data" ]; then
  log "ERROR: snapshot not found at $SNAPSHOT_DIR, aborting"
  exit 1
fi

log "reset start"

# コンテナが動いているうちに退避しておく（保険）。
backup_subscribers

# 最新版の取り込みとビルドも、まだデモが動いているうちに済ませる（ビルドは数分かかりうる）。
update_to_latest

docker compose -f "$COMPOSE_FILE" stop ldap db arc graphy-backend >> "$LOG_FILE" 2>&1

DATA_DIR="$(dirname "$COMPOSE_FILE")/data"
docker run --rm \
  -v "$DATA_DIR":/dst \
  -v "$SNAPSHOT_DIR/data":/src:ro \
  alpine sh -c "rm -rf /dst/* && cp -a /src/. /dst/" >> "$LOG_FILE" 2>&1

# 巻き戻すのは graphy_backend_data だけ。demo_graphy_subscriber_data には触れないこと
# （お知らせメール登録者が消える。ここが分離されている理由そのもの）。
docker run --rm \
  -v demo_graphy_backend_data:/dst \
  -v "$SNAPSHOT_DIR/graphy_backend_data":/src:ro \
  alpine sh -c "rm -rf /dst/* && cp -a /src/. /dst/" >> "$LOG_FILE" 2>&1

docker compose -f "$COMPOSE_FILE" start ldap db arc >> "$LOG_FILE" 2>&1
# graphy-backend だけ up -d で起こす。イメージが焼き直されていればここで作り直され、
# 変わっていなければ start と同じ挙動になる（前夜のビルドだけ通って差し替えに失敗した、
# といった取りこぼしもここで解消される）。
docker compose -f "$COMPOSE_FILE" up -d graphy-backend >> "$LOG_FILE" 2>&1

log "reset done ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
