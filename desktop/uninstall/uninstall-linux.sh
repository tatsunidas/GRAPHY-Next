#!/bin/bash
# GRAPHY-Next — Linux アンインストーラ / Uninstaller (.deb / AppImage)
#
# .deb で入れた場合: 本体は apt で外す（sudo が要るので、このスクリプトはコマンドを案内するだけ）。
# AppImage の場合: OS 側にインストーラ登録が無いので、AppImage ファイルの削除が本体の削除。
# どちらも、保存データ/デスクトップ統合の削除は任意で、ここで確認します。
#
# 使い方: ターミナルで実行  ->  bash uninstall-linux.sh
#
# 保存データの場所: ~/.config/GRAPHY-Next
set -u

DATA_DIR="$HOME/.config/GRAPHY-Next"

echo "=== GRAPHY-Next Uninstaller (Linux) ==="

# AppImage 内部から起動された場合は $APPIMAGE にパスが入る。分かる範囲で削除を申し出る。
if [ -n "${APPIMAGE:-}" ] && [ -f "${APPIMAGE:-}" ]; then
  echo "AppImage: $APPIMAGE"
  read -r -p "この AppImage ファイルを削除しますか? Delete this AppImage file? [y/N]: " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) rm -f "$APPIMAGE" && echo "AppImage を削除しました / removed." ;;
    *) echo "AppImage は残しました / kept: $APPIMAGE" ;;
  esac
elif dpkg -s graphy-next-desktop >/dev/null 2>&1; then
  echo ".deb で入っています。本体は次のコマンドで外してください / installed from .deb; remove it with:"
  echo "  sudo apt remove graphy-next-desktop"
else
  echo "AppImage 本体（GRAPHY-Next-*.AppImage）は手動で削除してください / delete the .AppImage file manually."
fi

# appimaged / AppImageLauncher が作るデスクトップ統合（.desktop / アイコン）を掃除する。
for f in "$HOME/.local/share/applications/"*GRAPHY-Next*.desktop \
         "$HOME/.local/share/applications/appimagekit"*graphy*next*.desktop \
         "$HOME/.local/share/icons/hicolor/"*/apps/*graphy-next*.png; do
  [ -e "$f" ] && rm -f "$f" && echo "削除 / removed: $f"
done

if [ -d "$DATA_DIR" ]; then
  echo ""
  echo "保存データ / Stored data: $DATA_DIR"
  read -r -p "DICOM 画像・データベース・plugins も削除しますか? Delete stored data too? [y/N]: " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) rm -rf "$DATA_DIR" && echo "保存データを削除しました / data removed." ;;
    *) echo "保存データは残しました / data kept: $DATA_DIR" ;;
  esac
fi

echo ""
echo "完了しました / Done."
