#!/usr/bin/env bash
#
# Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
# Author: Tatsuaki Kobayashi
#
# NonDicomImporter の動画(AVI/非H.264 MP4)トランスコード用に、各 OS/アーキの ffmpeg バイナリを
# desktop/resources/ffmpeg/<os-arch>/ffmpeg[.exe] へ取得する（リリース同梱用）。
# electron-builder の extraResources で resources/ffmpeg → Resources/ffmpeg として同梱される。
#
# 使い方:
#   scripts/fetch-ffmpeg.sh                 # 既定の全ターゲットを取得
#   scripts/fetch-ffmpeg.sh linux-x64 win-x64   # 指定ターゲットのみ
#   FFMPEG_STATIC_TAG=b6.0 scripts/fetch-ffmpeg.sh   # 取得バージョン(タグ)を固定
#
# 取得元: eugeneware/ffmpeg-static の GitHub Releases（各プラットフォーム単一バイナリの gzip）。
#   https://github.com/eugeneware/ffmpeg-static/releases
#
# ライセンス注意: 配布される ffmpeg は GPL ビルド（x264 等を含む）。製品同梱時は GPL の義務
# （対応ソースの提供）と H.264 の特許(MPEG-LA)を確認すること。詳細は fw/nondicom-ffmpeg.md。
set -euo pipefail

TAG="${FFMPEG_STATIC_TAG:-b6.0}"
BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${FFMPEG_OUT_DIR:-$SCRIPT_DIR/../desktop/resources/ffmpeg}"

DEFAULT_TARGETS=(linux-x64 linux-arm64 win-x64 mac-x64 mac-arm64)
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${DEFAULT_TARGETS[@]}")

# target -> "<release-asset> <bin-name>"
asset_for() {
  case "$1" in
    linux-x64)   echo "ffmpeg-linux-x64.gz ffmpeg" ;;
    linux-arm64) echo "ffmpeg-linux-arm64.gz ffmpeg" ;;
    win-x64)     echo "ffmpeg-win32-x64.gz ffmpeg.exe" ;;
    mac-x64)     echo "ffmpeg-darwin-x64.gz ffmpeg" ;;
    mac-arm64)   echo "ffmpeg-darwin-arm64.gz ffmpeg" ;;
    *)           return 1 ;;
  esac
}

host_target() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Linux) os=linux ;; Darwin) os=mac ;; *) os=other ;; esac
  case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch=other ;; esac
  echo "$os-$arch"
}

HOST="$(host_target)"
fail=0
echo "ffmpeg-static tag=$TAG -> $OUT_ROOT"

for t in "${TARGETS[@]}"; do
  if ! read -r asset bin <<<"$(asset_for "$t")"; then
    echo "[$t] 未知のターゲット（skip）" >&2
    continue
  fi
  dir="$OUT_ROOT/$t"
  mkdir -p "$dir"
  url="$BASE/$asset"
  echo "[$t] download $url"
  if ! curl -fL --retry 3 "$url" -o "$dir/$bin.gz"; then
    echo "[$t] ダウンロード失敗: $url" >&2
    rm -f "$dir/$bin.gz"
    fail=1
    continue
  fi
  gunzip -f "$dir/$bin.gz"
  chmod +x "$dir/$bin" 2>/dev/null || true
  size="$(wc -c < "$dir/$bin" | tr -d ' ')"
  if [ "$size" -lt 1000000 ]; then
    echo "[$t] 取得物が小さすぎます（${size}B）。URL/タグを確認してください。" >&2
    fail=1
    continue
  fi
  # 自ホスト向けのみ実行検証
  if [ "$t" = "$HOST" ]; then
    if "$dir/$bin" -version >/dev/null 2>&1; then
      echo "[$t] OK ($size B, -version 検証済)"
    else
      echo "[$t] 警告: -version 実行に失敗（実行権限/依存を確認）" >&2
    fi
  else
    echo "[$t] OK ($size B)"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "一部ターゲットの取得に失敗しました。" >&2
  exit 1
fi
echo "完了: $OUT_ROOT 配下に各ターゲットの ffmpeg を配置しました。"
