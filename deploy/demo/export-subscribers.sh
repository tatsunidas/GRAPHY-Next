#!/usr/bin/env bash
# お知らせメール送付先一覧をCSVで書き出す。
# 登録経路は2つ（ログイン画面のオプトイン・チェックボックス、graphy.vis-ionary.com の更新通知
# 登録フォーム）だが、どちらも同じ MAILING_LIST_SUBSCRIBER に入る。
#
# 配信停止済み（UNSUBSCRIBED_AT が入っている）アドレスは常に除外するため、このCSVをそのまま
# 配信リストとして使えばうっかり停止済みへ送ってしまう事故を構造的に防げる。
#
# PRODUCTS 列は購読対象（graphy / graphy-next のカンマ区切り）。GRAPHY と GRAPHY-Next は
# リリースが独立しているため、実際の配信ではこの列で宛先を絞ること。
#
# 読み出し経路は「コンテナ内で一時CSVを作らせて host 側へ取り出す」だけに限る
# （公開デモにメーリングリストを読み出せるHTTPエンドポイントは持たせない方針のため）。
#
# 使い方: deploy/demo/export-subscribers.sh [出力先パス（省略時: ./subscribers.csv）]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE_FILE="./docker-compose.yml"
# shellcheck source=./lib-h2.sh
source ./lib-h2.sh

OUT="${1:-subscribers.csv}"

set +e
h2_export_csv "$SUBSCRIBER_DB_URL" \
  "SELECT EMAIL, SUBSCRIBED_AT, PRODUCTS FROM MAILING_LIST_SUBSCRIBER WHERE UNSUBSCRIBED_AT IS NULL ORDER BY SUBSCRIBED_AT" \
  "$OUT"
status=$?
set -e

case "$status" in
  0) echo "書き出し完了: $OUT ($(($(wc -l < "$OUT") - 1)) 件、配信停止済みは除外済み)" ;;
  2)
    echo "MAILING_LIST_SUBSCRIBER がまだ存在しません（登録者0件）。" >&2
    echo "graphy-backend を一度起動すれば作成されます。" >&2
    exit 1
    ;;
  *)
    echo "書き出しに失敗しました。graphy-backend が起動しているか確認してください。" >&2
    echo "${H2_LAST_ERROR:-}" >&2
    exit 1
    ;;
esac
