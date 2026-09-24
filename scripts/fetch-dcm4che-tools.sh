#!/usr/bin/env bash
#
# Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
# Author: Tatsuaki Kobayashi
#
# QR（Query/Retrieve）画面の C-FIND/C-MOVE/C-GET が起動する dcm4che CLI ツール
# （findscu/movescu/getscu/storescu 等）一式を desktop/resources/dcm4che へ取得する
# （リリース同梱用）。electron-builder の extraResources で resources/dcm4che →
# Resources/dcm4che として同梱される。backend 側の解決は Dcm4cheTools.java を参照。
#
# ツール本体は Java 製（bin/findscu 等は同梱 jar を起動するラッパー）なので OS/アーキ別の
# 配布は不要——1 つの zip を全 OS で共有する。バイナリ実行に必要な JVM は、backend を
# 起動している同梱 JRE を Dcm4cheTools が JAVA_HOME として渡すため、追加同梱不要。
#
# ⚠ 例外が 1 つある: **OpenCV ネイティブ（lib/<os-arch>/）だけは OS/アーキ別**。
#   匿名化の焼き込みが圧縮画素を伸長するのに使う（backend の PixelCodec）。取得元 zip には
#   全プラットフォーム分（7 種・計 113MB）が入っているが、**このホストの 1 つだけ**を置く
#   ——extraResources が resources/dcm4che を丸ごと同梱するため、全部置くとどの OS の
#   インストーラも +113MB になる。クロスビルド時は DCM4CHE_ALL_NATIVES=1。
#
# 使い方:
#   scripts/fetch-dcm4che-tools.sh
#   DCM4CHE_TOOLS_VERSION=5.34.3 scripts/fetch-dcm4che-tools.sh   # 取得バージョンを固定
#   scripts/fetch-dcm4che-tools.sh --check                          # 取得せず、このホスト向けに
#                                                                  # 揃っているかだけ点検
#   DCM4CHE_ALL_NATIVES=1 scripts/fetch-dcm4che-tools.sh           # 全プラットフォームの
#                                                                  # OpenCV ネイティブを置く
#                                                                  # （クロスビルド用・+113MB）
#
# 取得元: dcm4che の SourceForge 配布（GitHub Releases にはバイナリ添付が無いため）。
#   https://sourceforge.net/projects/dcm4che/files/dcm4che3/
#
# backend/pom.xml の dcm4che.version と一致させること（DIMSE プロトコル実装のずれを避ける）。
set -euo pipefail

VERSION="${DCM4CHE_TOOLS_VERSION:-5.34.3}"
URL="https://sourceforge.net/projects/dcm4che/files/dcm4che3/${VERSION}/dcm4che-${VERSION}-bin.zip/download"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${DCM4CHE_TOOLS_OUT_DIR:-$SCRIPT_DIR/../desktop/resources/dcm4che}"
# このホストに対応する dcm4che の lib/<os-arch> ディレクトリ名。
#
# 🔴 **この対応表の 2 つ目を書かないこと。** 取得（下）と点検（--check）と Makefile の
#    冪等ガードが同じ判定を使う。別々に書くと「取得はしたのに点検が別の場所を見る」形で、
#    **中身が違う配布物が検査を通る**。ffmpeg の fetch-ffmpeg.sh と同じ uname 由来の規則。
host_native_dir() {
  local os arch n_os n_arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)  n_os=linux;;
    Darwin) n_os=macosx;;
    *)      n_os=windows;;   # MINGW64_NT / MSYS_NT（GitHub Actions の windows runner は bash）
  esac
  case "$arch" in
    x86_64|amd64)  n_arch=x86-64;;
    aarch64|arm64) n_arch=aarch64;;
    i?86)          n_arch=x86;;
    *)             n_arch=x86-64;;
  esac
  printf '%s-%s' "$n_os" "$n_arch"
}
HOST_NATIVE="$(host_native_dir)"

# --check: 取得せずに「このホスト向けに揃っているか」だけ見る（Makefile の冪等ガード・CI の点検用）。
# 🔴 **ネイティブは「どれか 1 つある」では不十分**——別プラットフォームのものが残っていると、
#    ガードは通るのに実行時には読めない。必ず **このホスト向けのもの** を見る。
if [ "${1:-}" = "--check" ]; then
  missing=""
  [ -x "$OUT_DIR/bin/movescu" ] || missing="$missing QR ツール(bin/movescu)"
  ls "$OUT_DIR/lib/$HOST_NATIVE"/*opencv_java* >/dev/null 2>&1 \
    || missing="$missing OpenCVネイティブ(lib/$HOST_NATIVE)"
  if [ -n "$missing" ]; then
    echo "dcm4che 同梱物が不足:$missing（host=$HOST_NATIVE）" >&2
    exit 1
  fi
  echo "dcm4che 同梱物: 揃っています（host=$HOST_NATIVE）"
  exit 0
fi

TMP_ZIP="$(mktemp -t dcm4che-tools-XXXXXX.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "dcm4che-tools version=$VERSION -> $OUT_DIR"
echo "download $URL"
if ! curl -fL --retry 3 "$URL" -o "$TMP_ZIP"; then
  echo "ダウンロード失敗: $URL" >&2
  exit 1
fi

size="$(wc -c < "$TMP_ZIP" | tr -d ' ')"
if [ "$size" -lt 10000000 ]; then
  echo "取得物が小さすぎます（${size}B）。VERSION/URL を確認してください。" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/lib" "$OUT_DIR/etc"
TMP_EXTRACT="$(mktemp -d -t dcm4che-tools-extract-XXXXXX)"
trap 'rm -f "$TMP_ZIP"; rm -rf "$TMP_EXTRACT"' EXIT
unzip -q "$TMP_ZIP" -d "$TMP_EXTRACT"
SRC="$TMP_EXTRACT/dcm4che-${VERSION}"

# フル配布は 100+ ツール分の lib（150MB超）を含むが、使うのは findscu/movescu/getscu/storescu
# の 4 本だけ。各ラッパー(bin/<tool>)の classpath 行から要る jar を集めて、それだけをコピーする
# （フル同梱の 1/30 以下・数MBに収まる）。
TOOLS=(findscu movescu getscu storescu)
for t in "${TOOLS[@]}"; do
  cp "$SRC/bin/$t" "$SRC/bin/$t.bat" "$OUT_DIR/bin/"
  cp -r "$SRC/etc/$t" "$OUT_DIR/etc/$t"
done
cp -r "$SRC/etc/certs" "$OUT_DIR/etc/certs"
chmod +x "$OUT_DIR"/bin/* 2>/dev/null || true

JARS=()
while IFS= read -r j; do
  JARS+=("$j")
done < <(
  grep -h '\$DCM4CHE_HOME/lib/' "${TOOLS[@]/#/$SRC/bin/}" \
    | sed -nE 's#.*/lib/([A-Za-z0-9_.-]+\.jar)".*#\1#p' | sort -u
)
for j in "${JARS[@]}"; do
  if [ ! -f "$SRC/lib/$j" ]; then
    echo "警告: lib/$j が配布物に見つかりません（構成が変わった可能性）" >&2
    continue
  fi
  cp "$SRC/lib/$j" "$OUT_DIR/lib/$j"
done
for t in "${TOOLS[@]}"; do
  cp "$SRC/lib/dcm4che-tool-$t-${VERSION}.jar" "$OUT_DIR/lib/"
done

# OpenCV ネイティブ（lib/<os-arch>/）を、**このホスト向けの 1 つだけ**置く。
# 判定の正本は host_native_dir()（ファイル冒頭）。
NATIVE_FOUND=0
for d in "$SRC"/lib/*/; do
  plat="$(basename "$d")"
  case "$plat" in
    linux-*|windows-*|macosx-*) ;;
    *) continue;;
  esac
  if [ "${DCM4CHE_ALL_NATIVES:-0}" != "1" ] && [ "$plat" != "$HOST_NATIVE" ]; then
    continue
  fi
  if ls "$d" 2>/dev/null | grep -qiE 'opencv_java'; then
    mkdir -p "$OUT_DIR/lib/$plat"
    cp "$d"/* "$OUT_DIR/lib/$plat/"
    NATIVE_FOUND=$((NATIVE_FOUND + 1))
  fi
done
if [ "$NATIVE_FOUND" -eq 0 ]; then
  echo "警告: このホスト（$HOST_NATIVE）向けの OpenCV ネイティブが配布物に見つかりません。" >&2
  echo "      圧縮画像の焼き込み除去が使えません（backend が実行前に中止します）。" >&2
  echo "      配布物の構成が変わったか、対応していないプラットフォームです。" >&2
else
  echo "OpenCV ネイティブ: $NATIVE_FOUND プラットフォーム分を配置しました（host=$HOST_NATIVE）。"
fi

for t in "${TOOLS[@]}"; do
  if [ ! -f "$OUT_DIR/bin/$t" ]; then
    echo "警告: $OUT_DIR/bin/$t が見つかりません（配布物の構成が変わった可能性）" >&2
  fi
done

echo "完了: $OUT_DIR 配下に dcm4che-tools $VERSION を配置しました。"
