#!/usr/bin/env bash
# automator が残した孤児プロセス（backend / Vite）だけを止める。
#
# ⚠️ **このリポジトリのパスと automator の既定ポート（18090/18091/18093）に一致するものだけ**を
#    対象にする。同じマシンで動いている別物（bench 常駐の backend は 8099/11122、
#    ローカル dcm4chee は 8080/11112）を巻き込まないため。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTP_PORT="${GRAPHY_AUTOMATOR_HTTP_PORT:-18090}"
VITE_PORT="${GRAPHY_AUTOMATOR_VITE_PORT:-18093}"

killed=0
while read -r pid args; do
  [ -z "${pid:-}" ] && continue
  case "$args" in
    *"$ROOT"*"--server.port=$HTTP_PORT"*|*"vite --port $VITE_PORT"*|*"dev --port $VITE_PORT"*)
      echo "kill $pid  ($(echo "$args" | cut -c1-90))"
      kill "$pid" 2>/dev/null && killed=$((killed+1))
      ;;
  esac
done < <(ps -eo pid=,args=)

sleep 2
echo "止めたプロセス: $killed"
ss -ltn 2>/dev/null | grep -E ":$HTTP_PORT|:$VITE_PORT" || echo "ポート $HTTP_PORT / $VITE_PORT は空きました"
