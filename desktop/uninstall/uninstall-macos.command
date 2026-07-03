#!/bin/bash
# GRAPHY-Next — macOS アンインストーラ / Uninstaller
#
# 使い方: Finder でこのファイルをダブルクリック（または Terminal で実行）。
#   - アプリ本体 /Applications/GRAPHY-Next.app をゴミ箱ではなく直接削除します。
#   - 続いて「保存データ(DICOM/DB/plugins)も削除するか」を確認します（既定は保持）。
#
# 保存データの場所: ~/Library/Application Support/GRAPHY-Next
set -u

APP="/Applications/GRAPHY-Next.app"
DATA_DIR="$HOME/Library/Application Support/GRAPHY-Next"

echo "=== GRAPHY-Next Uninstaller (macOS) ==="

# 起動中なら終了させる。
osascript -e 'quit app "GRAPHY-Next"' >/dev/null 2>&1 || true
sleep 1

if [ -d "$APP" ]; then
  echo "アプリ本体を削除します / Removing: $APP"
  rm -rf "$APP" || { echo "削除に失敗しました。管理者権限が必要かもしれません:"; echo "  sudo rm -rf \"$APP\""; }
else
  echo "アプリ本体は見つかりませんでした（既に削除済み） / app not found."
fi

if [ -d "$DATA_DIR" ]; then
  echo ""
  echo "保存データ / Stored data: $DATA_DIR"
  read -r -p "DICOM 画像・データベース・plugins も削除しますか? Delete stored data too? [y/N]: " ans
  case "$ans" in
    [yY]|[yY][eE][sS])
      rm -rf "$DATA_DIR" && echo "保存データを削除しました / data removed." ;;
    *)
      echo "保存データは残しました / data kept: $DATA_DIR" ;;
  esac
fi

echo ""
echo "完了しました / Done."
read -r -p "Enter キーで閉じます / Press Enter to close..." _
