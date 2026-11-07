#!/usr/bin/env bash
# 起動（スプラッシュ → メイン画面）の時間を、ネットワークの状態を変えて測る（Linux・sudo 不要）。
#
#   online     通常（基準）
#   blackhole  LAN だけ繋がっていて、インターネットへ出る経路（既定ゲートウェイ・DNS）が黙ってパケットを捨てる
#              （「LAN/Wi-Fi は繋がっているが、インターネットには出られない」を再現する）
#   nonet      lo だけ（ネットワークインターフェースなし）
#   check      blackhole の環境が実際に待たされることの確認（DNS 解決・接続・InetAddress.getLocalHost の時間）
#
# 使い方:  automator/scripts/offline-startup.sh <online|blackhole|nonet|check> [ラベル]
# 結果:    automator/.results/offline-startup/<ラベル>/result.json（スプラッシュ・メイン画面が見えた時刻）と main-stdout.txt
#
# 前提: backend/target/graphy-next-backend.jar（直近のビルド）、frontend・desktop・automator の `npm ci` 済み、DISPLAY。
# 専用ポートは PROBE_HTTP / PROBE_VITE、データ置き場は PROBE_DATA_DIR（空のフォルダ。初回は DB を作るので 2 回走らせ 2 回目を使う）。
# blackhole・nonet は `unshare -rnm`（ユーザー・ネットワーク・マウントの各名前空間）の中で動かすので、ホストのネットワーク設定は変わらない。
set -euo pipefail

mode="${1:?使い方: offline-startup.sh <online|blackhole|nonet|check> [ラベル]}"
label="${2:-$mode}"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/.results/offline-startup"
mkdir -p "$out"

setup_net() {
  ip link set lo up
  if [ "$1" = blackhole ]; then
    ip link add v0 type veth peer name v1
    ip addr add 192.168.77.2/24 dev v0
    ip link set v0 up; ip link set v1 up
    # 存在しないゲートウェイの MAC を静的に置く: ARP で失敗せず、パケットは出てそのまま捨てられる（ファイアウォールの黙殺と同じ）
    ip neigh add 192.168.77.1 lladdr 02:00:00:00:00:01 dev v0 nud permanent
    ip route add default via 192.168.77.1
    printf 'nameserver 192.168.77.1\n' > "$out/resolv.$label"
    mount --bind "$out/resolv.$label" /etc/resolv.conf
  fi
}

run_check() {
  t() { local s; s=$(date +%s.%N); "$@" >/dev/null 2>&1; echo "rc=$? $(echo "$(date +%s.%N) - $s" | bc)s"; }
  echo "getent hosts api.github.com : $(t getent hosts api.github.com)"
  echo "curl -m 20 https://api.github.com : $(t curl -s -m 20 https://api.github.com/)"
  cat >"$out/H.java" <<'J'
public class H { public static void main(String[] a) throws Exception { long t = System.nanoTime(); String h; try { h = java.net.InetAddress.getLocalHost().getHostName(); } catch (Exception e) { h = "ERR " + e; } System.out.println("InetAddress.getLocalHost -> " + h + " " + (System.nanoTime() - t) / 1e9 + "s"); } }
J
  java "$out/H.java"
}

run_probe() {
  cd "$here"
  PROBE_DATA_DIR="${PROBE_DATA_DIR:-$out/data}" timeout 300 npx tsx src/spike/offlineStartupProbe.ts "$label" "$out/$label"
}

case "$mode" in
  online) run_probe ;;
  check)  unshare -rnm bash -c "$(declare -f setup_net); out='$out'; label='$label'; setup_net blackhole; $(declare -f run_check); run_check" ;;
  blackhole|nonet)
    unshare -rnm bash -c "$(declare -f setup_net run_probe); here='$here'; out='$out'; label='$label'; export PROBE_DATA_DIR='${PROBE_DATA_DIR:-$out/data}'; setup_net $mode; run_probe" ;;
  *) echo "不明なモード: $mode" >&2; exit 2 ;;
esac
