#!/usr/bin/env bash
# インストール手順書（docs/install.md）用に、Linux（.deb）を入れて起動した画面を撮る。release.yml の install-shots ジョブから
# xvfb-run の中で呼ぶ。
#   使い方: bash linux.sh <deb> <出力ディレクトリ>
#   linux-1-launched-deb  `sudo apt install ./xxx.deb` で入れ、--no-sandbox なしで起動した画面
# 撮れなかった画面は report.txt に残し、終了コードは 0。
set -u
DEB="$1"; OUT="$2"; mkdir -p "$OUT"
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/log.txt"; }
sudo apt-get install -y -qq "$(realpath "$DEB")" >>"$OUT/log.txt" 2>&1; log "apt install rc=$?"
LANG=ja_JP.UTF-8 LANGUAGE=ja graphy-next-desktop >"$OUT/app.txt" 2>&1 &
PID=$!
sleep 45
if kill -0 "$PID" 2>/dev/null; then
  # 背景の黒を切り落として、アプリの窓だけにする
  import -window root png:- | convert - -trim +repage "$OUT/linux-1-launched-deb.png" && log "shot linux-1-launched-deb"
  kill "$PID"
else
  log "app exited early"; tail -20 "$OUT/app.txt" | tee -a "$OUT/log.txt"
fi
{ [ -s "$OUT/linux-1-launched-deb.png" ] && echo "linux-1-launched-deb ok" || echo "linux-1-launched-deb MISSING"; } | tee "$OUT/report.txt"

exit 0
