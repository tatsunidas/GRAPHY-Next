#!/usr/bin/env bash
# graphy-backend コンテナ内の H2 へ、アプリを止めずに接続するための共通処理。
# 単体では実行せず、同ディレクトリのスクリプトから `source` して使う。
# 呼び出し側で COMPOSE_FILE を定義しておくこと。
#
# ★ 起動方法の注意
#   app.jar は Spring Boot の実行可能jarで、依存ライブラリは BOOT-INF/lib/ の中に
#   「jar in jar」で入っている。そのため `java -cp app.jar org.h2.tools.Shell` では
#   ClassNotFoundException になる（見落としやすい。実際この形で書かれていて動かなかった）。
#   loader.main を指定して PropertiesLauncher から起動すると、BOOT-INF/lib/ が
#   クラスパスに載った状態で任意の main クラスを実行できる。
#
# ★ 接続の注意
#   どちらのDBも AUTO_SERVER=TRUE で開かれているため、アプリが掴んだままでも
#   別プロセスから追加接続できる（読み書きとも可）。

# お知らせメール登録者だけを置く専用DB。夜間リセット（reset-demo.sh）の対象外。
SUBSCRIBER_DB_URL="jdbc:h2:file:/app/subscribers/graphy-subscribers;AUTO_SERVER=TRUE"

# アプリ本体のDB（DICOM索引・レポート・設定・匿名化マスク）。毎晩リセットされる。
APP_DB_URL="jdbc:h2:file:/app/data/graphy-index;AUTO_SERVER=TRUE"

# h2_shell <jdbc-url> <sql>
# 標準出力・標準エラーをまとめて返す。
# 注意: H2 の Shell は SQL エラーでも終了コード0を返すことがある。成否は「期待したファイルが
# できたか」「件数が読めたか」で判定すること（呼び出し側の責務）。
h2_shell() {
  local url="$1"
  local sql="$2"
  docker compose -f "$COMPOSE_FILE" exec -T graphy-backend \
    java -Dloader.main=org.h2.tools.Shell \
      -cp app.jar org.springframework.boot.loader.launch.PropertiesLauncher \
      -url "$url" -user sa -password "" -sql "$sql" 2>&1
}

# h2_export_csv <jdbc-url> <select-sql> <ホスト側の出力パス>
# コンテナ内に一時CSVを作らせてから host 側へ取り出す（公開デモに一覧を返すHTTP APIを
# 持たせない方針のため、取り出しは常にこの経路）。
# select-sql はSQL文字列リテラルの中に埋め込むので、シングルクォートを含めないこと。
# 戻り値 0: 成功 / 1: 失敗 / 2: テーブルが存在しない
h2_export_csv() {
  local url="$1"
  local select_sql="$2"
  local out="$3"
  local tmp="/app/subscribers/.h2-export-$$.csv"
  local sql_out

  sql_out="$(h2_shell "$url" "CALL CSVWRITE('$tmp', '$select_sql')" || true)"

  if grep -qi 'not found' <<<"$sql_out"; then
    return 2
  fi

  if ! docker compose -f "$COMPOSE_FILE" exec -T graphy-backend cat "$tmp" > "$out" 2>/dev/null; then
    H2_LAST_ERROR="$sql_out"
    return 1
  fi
  docker compose -f "$COMPOSE_FILE" exec -T graphy-backend rm -f "$tmp" >/dev/null 2>&1 || true

  # CSVWRITE が動いていればヘッダ行が必ず入る。空ファイル＝書き出せていない。
  if [ ! -s "$out" ]; then
    H2_LAST_ERROR="$sql_out"
    return 1
  fi
  return 0
}

# h2_row_count <jdbc-url> <テーブル名>
# 件数を標準出力に返す。読めなければ空文字。
h2_row_count() {
  local url="$1"
  local table="$2"
  local tmp_host
  tmp_host="$(mktemp)"
  if h2_export_csv "$url" "SELECT COUNT(*) AS N FROM $table" "$tmp_host"; then
    tail -1 "$tmp_host" | tr -d '"[:space:]'
  fi
  rm -f "$tmp_host"
}
