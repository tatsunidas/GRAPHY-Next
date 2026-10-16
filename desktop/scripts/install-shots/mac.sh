#!/usr/bin/env bash
# インストール手順書（docs/install.md）用に、Mac の初回の画面を撮る。release.yml の install-shots ジョブから呼ぶ。
#   使い方: bash mac.sh <dmg> <出力ディレクトリ>
# ブラウザで落とした状態（com.apple.quarantine）を再現し、日本語表示で次を撮る:
#   mac-1-dmg       dmg を開いた窓（Applications へドラッグ）
#   mac-2-blocked   初回起動の警告「開いていません」
#   mac-3-settings  システム設定 ＞ プライバシーとセキュリティ の「このまま開く」
#   mac-4-confirm   「このまま開く」を押した後の確認
# 撮れなかった画面は report.txt に残し、終了コードは 0 にする（リリースは止めない）。
set -u
DMG="$1"; OUT="$2"; mkdir -p "$OUT"
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/log.txt"; }
shot() { screencapture -x "$OUT/$1.png" && log "shot $1"; }
ax() { osascript -e "$1" 2>&1 | tee -a "$OUT/log.txt"; }

# 表示を日本語にする（設定の読み直しのため cfprefsd と UI のプロセスを再起動する）
defaults write -g AppleLanguages -array ja-JP en-US
defaults write -g AppleLocale ja_JP
killall cfprefsd 2>/dev/null; sleep 3
for p in Finder SystemUIServer CoreServicesUIAgent; do killall "$p" 2>/dev/null; done
sleep 6

cp "$DMG" /tmp/install-shots.dmg
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" /tmp/install-shots.dmg
open /tmp/install-shots.dmg
sleep 20
shot mac-1-dmg

VOL=$(ls -d /Volumes/GRAPHY* | head -1)
APP_NAME=$(basename "$(ls -d "$VOL"/*.app | head -1)")
ditto "$VOL/$APP_NAME" "/Applications/$APP_NAME"
osascript -e 'tell application "Finder" to close every window' >/dev/null 2>&1
( open "/Applications/$APP_NAME" & )
sleep 25
shot mac-2-blocked
ax 'tell application "System Events" to tell process "CoreServicesUIAgent" to click (first button of window 1 whose name is "完了" or name is "Done")'
sleep 3

open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension"
sleep 15
# 右側の一覧を一番下まで送る（AX のスクロールは効かないので、マウスホイールを送る）
read -r X Y W H < <(osascript -e 'tell application "System Events" to tell process "System Settings" to get {position, size} of window 1' | tr -d ',' )
log "settings window: $X $Y $W $H"
cat > /tmp/scroll.swift <<'SW'
import CoreGraphics
import Foundation
let p = CGPoint(x: Double(CommandLine.arguments[1])!, y: Double(CommandLine.arguments[2])!)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(300000)
for _ in 0..<40 {
  CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -300, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
  usleep(50000)
}
SW
swift /tmp/scroll.swift $((X + W * 7 / 10)) $((Y + H / 2)) 2>&1 | tail -3 | tee -a "$OUT/log.txt"
sleep 3
shot mac-3-settings

cat > /tmp/open-anyway.applescript <<'AS'
tell application "System Events"
  tell process "System Settings"
    repeat with e in (entire contents of window 1)
      try
        if class of e is button and (name of e is "このまま開く" or name of e is "Open Anyway") then
          click e
          return "clicked"
        end if
      end try
    end repeat
    return "not found"
  end tell
end tell
AS
RES=$(osascript /tmp/open-anyway.applescript 2>&1); log "open anyway: $RES"
if [ "$RES" = "clicked" ]; then
  sleep 8
  shot mac-4-confirm
fi

for n in mac-1-dmg mac-2-blocked mac-3-settings mac-4-confirm; do
  [ -s "$OUT/$n.png" ] && echo "$n ok" || echo "$n MISSING"
done | tee "$OUT/report.txt"
exit 0
