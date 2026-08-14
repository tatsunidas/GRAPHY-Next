#!/usr/bin/env bash
# Rubo Medical が公開している DICOM サンプルのうち、アンギオ（XA/XRF）のものを取得する。
# fw/angio-design.md §16.2 の「実 DICOM XA マルチフレーム」の入手経路。
#
# 取得物は automator/fixtures/xa-angio/ に置く。**このディレクトリは .gitignore 済み**で、
# リポジトリには入らない（bench の DICOM 生成物と同じ扱い。取得スクリプトだけを版管理する）。
#
# ⚠️ ライセンス: 配布ページに利用条件・ライセンスの明示は無い。ビューアの動作確認用に
#    公開されているサンプルなので**手元での検証にのみ使う**。再配布しないこと。
#    出典: https://www.rubomedical.com/dicom_files/
set -euo pipefail

BASE_URL="https://www.rubomedical.com/dicom_files"
DEST="$(cd "$(dirname "$0")/.." && pwd)/fixtures/xa-angio"
WORK="$DEST/.download"

# 何が入っているか（2026-08-14 に実データで確認した内容）:
#   0002  XA  512x512x8bit  96 frames  JPEG Baseline  FrameTime=33ms(≈30fps)  MaskSubtractionSeq あり(NONE)
#   0003  XA  512x512x8bit  17 frames  JPEG Baseline  FrameTime=66ms(≈15fps)  biplane 対の片方
#   0004  XA  512x512x8bit  17 frames  JPEG Baseline  FrameTime=66ms(≈15fps)  biplane 対のもう片方
#   0009  XA  512x512x8bit 137 frames  JPEG Baseline  FrameTime=40ms(=25fps)
#   0012  XA  512x512x8bit  70 frames  JPEG Baseline  FrameTime=40ms(=25fps)
#   0015  RF 1024x1024x8bit  単一フレーム 非圧縮       ← シネ展開の**対象外**であることの確認用
FILES=(0002 0003 0004 0009 0012 0015)

mkdir -p "$WORK"
for n in "${FILES[@]}"; do
  zip="$WORK/dicom_viewer_${n}.zip"
  if [ ! -f "$zip" ]; then
    echo "取得中: dicom_viewer_${n}.zip"
    curl -fsS --max-time 180 -o "$zip" "$BASE_URL/dicom_viewer_${n}.zip"
  fi
  # -j でディレクトリ構造を捨てて DEST 直下へ、-o で既存を上書き。
  unzip -o -q -j "$zip" -d "$DEST"
done

chmod u+w "$DEST"/*.DCM 2>/dev/null || true
echo "配置先: $DEST"
ls -1 "$DEST"/*.DCM
