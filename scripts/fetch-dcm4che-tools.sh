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
# 使い方:
#   scripts/fetch-dcm4che-tools.sh
#   DCM4CHE_TOOLS_VERSION=5.34.3 scripts/fetch-dcm4che-tools.sh   # 取得バージョンを固定
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

for t in "${TOOLS[@]}"; do
  if [ ! -f "$OUT_DIR/bin/$t" ]; then
    echo "警告: $OUT_DIR/bin/$t が見つかりません（配布物の構成が変わった可能性）" >&2
  fi
done

echo "完了: $OUT_DIR 配下に dcm4che-tools $VERSION を配置しました。"
