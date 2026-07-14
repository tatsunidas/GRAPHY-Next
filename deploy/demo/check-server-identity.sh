#!/usr/bin/env bash
# 公開デモの操作（docker compose / .env編集 / cron / Cloudflare設定変更など）を、
# 実際にデモをホストしている物理サーバー機以外で行おうとしていないかを検証する。
#
# 使い方: deploy/demo/ 配下の設定・運用を変更する前に必ず実行する。
#   deploy/demo/check-server-identity.sh
# 失敗時（別マシンの疑い）は exit 1 で警告を出す。CI等では使わない、人・Claude向けの安全装置。
set -euo pipefail

IDENTITY_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.server-identity"

if [ ! -f "$IDENTITY_FILE" ]; then
  echo "WARN: $IDENTITY_FILE が見つかりません。識別情報が未記録のため照合できません。" >&2
  exit 1
fi

# shellcheck disable=SC1090
expected_hostname="$(grep '^hostname=' "$IDENTITY_FILE" | cut -d= -f2)"
expected_hash="$(grep '^machine_id_sha256=' "$IDENTITY_FILE" | cut -d= -f2)"

current_hostname="$(hostname)"
current_hash=""
if [ -r /etc/machine-id ]; then
  current_hash="$(printf '%s' "$(cat /etc/machine-id)" | sha256sum | awk '{print $1}')"
fi

if [ "$current_hash" = "$expected_hash" ] && [ -n "$current_hash" ]; then
  exit 0
fi

cat >&2 <<EOF

⚠️  警告: このマシンは公開デモのサーバー機ではない可能性があります。

  現在のホスト名   : $current_hostname
  期待するホスト名 : $expected_hostname
  machine-id 照合  : $([ "$current_hash" = "$expected_hash" ] && echo 一致 || echo 不一致/取得不可)

deploy/demo/ 配下の設定変更・docker compose操作・cron編集・Cloudflare設定変更は、
公開デモを実際にホストしている物理サーバー機（$expected_hostname）の上で行ってください。
別マシン（開発用Linux機・Windows等）での操作は、意図しない設定ズレや、
本番と異なる環境への誤デプロイの原因になります。

EOF
exit 1
