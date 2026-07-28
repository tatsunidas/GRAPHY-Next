#!/usr/bin/env bash
# 【1回だけ実行する移行スクリプト】
# お知らせメール登録者を、アプリ本体のH2（/app/data/graphy-index）から
# 専用DB（/app/subscribers/graphy-subscribers）へ移す。
#
# 経緯: 登録者テーブルは元々アプリ本体のH2に同居していたが、毎晩0:00の reset-demo.sh が
# /app/data を丸ごとゴールデンスナップショットへ巻き戻すため、日中の登録が毎晩消えていた。
# 対策として登録者だけを別ボリュームへ分離した（MailingListSubscriberRepository 参照）。
# 分離後の初回起動時、新しい専用DBは空なので、旧DBに残っている登録者をここで引き継ぐ。
#
# 実行タイミング: 新しいイメージをデプロイした直後、かつ次の 0:00（夜間リセット）より前。
#   リセットが走ると旧DB側の登録者は失われるため、その前に必ず実行すること。
#   MERGE で入れるので、複数回実行しても安全（重複しない・既存を壊さない）。
#
# 使い方: deploy/demo/migrate-subscribers-to-own-db.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE_FILE="./docker-compose.yml"
# shellcheck source=./lib-h2.sh
source ./lib-h2.sh

CONTAINER_CSV="/app/subscribers/.migrate-subscribers.csv"
HOST_CSV="$(mktemp)"
trap 'rm -f "$HOST_CSV"' EXIT

echo "移行前の件数:"
echo "  旧DB（アプリ本体）  : $(h2_row_count "$APP_DB_URL" MAILING_LIST_SUBSCRIBER || true)"
echo "  新DB（登録者専用）  : $(h2_row_count "$SUBSCRIBER_DB_URL" MAILING_LIST_SUBSCRIBER || true)"

set +e
h2_export_csv "$APP_DB_URL" \
  "SELECT EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT FROM MAILING_LIST_SUBSCRIBER" "$HOST_CSV"
status=$?
set -e

if [ "$status" -eq 2 ]; then
  echo "旧DBに MAILING_LIST_SUBSCRIBER がありません。移行するものはありません。"
  exit 0
fi
if [ "$status" -ne 0 ]; then
  echo "旧DBからの読み出しに失敗しました。graphy-backend が起動しているか確認してください。" >&2
  echo "${H2_LAST_ERROR:-}" >&2
  exit 1
fi

rows=$(($(wc -l < "$HOST_CSV") - 1))
if [ "$rows" -le 0 ]; then
  echo "旧DBの登録者は0件でした。移行するものはありません。"
  exit 0
fi

echo "旧DBから $rows 件を読み出しました。新DBへ取り込みます。"

docker compose -f "$COMPOSE_FILE" exec -T graphy-backend sh -c "cat > $CONTAINER_CSV" < "$HOST_CSV"

# 同じアドレスが両方にある場合は旧DB側（＝これまで使われていた実データ）で上書きする。
# 配信停止済みフラグもそのまま運ぶので、停止した相手が復活することはない。
merge_out="$(h2_shell "$SUBSCRIBER_DB_URL" \
  "MERGE INTO MAILING_LIST_SUBSCRIBER (EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT) KEY(EMAIL) SELECT EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT FROM CSVREAD('$CONTAINER_CSV')" || true)"

docker compose -f "$COMPOSE_FILE" exec -T graphy-backend rm -f "$CONTAINER_CSV" >/dev/null 2>&1 || true

after="$(h2_row_count "$SUBSCRIBER_DB_URL" MAILING_LIST_SUBSCRIBER || true)"
if [ -z "$after" ]; then
  echo "取り込み後の件数を確認できませんでした。新DBにテーブルがない可能性があります" >&2
  echo "（新しいイメージで graphy-backend が起動していれば自動作成されます）。" >&2
  echo "$merge_out" >&2
  exit 1
fi

echo "移行完了。新DB（登録者専用）の件数: $after"
echo "確認: deploy/demo/export-subscribers.sh /tmp/subscribers.csv"
