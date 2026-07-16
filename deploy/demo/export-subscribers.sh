#!/usr/bin/env bash
# ログイン画面のオプトイン・チェックボックスで登録された、お知らせメール送付先一覧をCSVで書き出す。
# 配信停止済み（unsubscribed_at が入っている）アドレスは常に除外するため、このCSVをそのまま
# 配信リストとして使えばうっかり停止済みへ送ってしまう事故を構造的に防げる。
#
# graphy-backend のH2は AUTO_SERVER=TRUE で起動しており、アプリを止めずに別プロセスから
# 追加でローカル接続できる。これを使い、コンテナ内で一時CSVを作らせてから host 側へ取り出す
# （公開デモにメーリングリストを読み出せるHTTPエンドポイントは持たせない方針のため）。
#
# 使い方: deploy/demo/export-subscribers.sh [出力先パス（省略時: ./subscribers.csv）]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

OUT="${1:-subscribers.csv}"
CONTAINER_TMP="/app/data/.subscribers-export.csv"

docker compose exec -T graphy-backend java -cp app.jar org.h2.tools.Shell \
  -url "jdbc:h2:file:/app/data/graphy-index;AUTO_SERVER=TRUE" \
  -user sa -password "" \
  -sql "CALL CSVWRITE('${CONTAINER_TMP}', 'SELECT EMAIL, SUBSCRIBED_AT FROM MAILING_LIST_SUBSCRIBER WHERE UNSUBSCRIBED_AT IS NULL ORDER BY SUBSCRIBED_AT')" \
  >/dev/null

docker compose exec -T graphy-backend cat "$CONTAINER_TMP" > "$OUT"
docker compose exec -T graphy-backend rm -f "$CONTAINER_TMP"

echo "書き出し完了: $OUT ($(($(wc -l < "$OUT") - 1)) 件、配信停止済みは除外済み)"
