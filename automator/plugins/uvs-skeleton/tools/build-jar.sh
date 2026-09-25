#!/usr/bin/env bash
# UVS プラグインの JAR 面をビルドする。
#
# 🔴 **本体の依存も要る。** 段 2 の手順（`javac -cp ../../../backend/target/classes`）は
#    プローブだけの頃は通ったが、解析コアを移植した今は RadiomicsJ / ImageJ / commons-math3 が
#    要るので、本体の**依存 jar のクラスパス**を Maven から取って足す。
#    （同梱はしない——親クラスローダから見えるものを二重に持たない・PORTED.md）
#
# ⚠️ **JAR を差し替えたら backend を再起動する。** プラグインのクラスローダは id 単位で
#    キャッシュされるので、動いているアプリに新しい JAR は届かない。
#
# 使い方: bash tools/build-jar.sh
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
backend="$repo/backend"
cpfile="$backend/target/uvs-plugin-classpath.txt"

if [ ! -d "$backend/target/classes" ]; then
  echo "backend が未ビルドです。先に: (cd backend && mvn -q -Dfrontend.skip=true compile)" >&2
  exit 1
fi

# 依存のクラスパスは変わることが少ないので、pom より古いときだけ取り直す。
if [ ! -f "$cpfile" ] || [ "$backend/pom.xml" -nt "$cpfile" ]; then
  echo "[uvs] 依存クラスパスを取得します（初回のみ時間がかかります）"
  (cd "$backend" && mvn -q -o dependency:build-classpath \
      -Dmdep.outputFile="$cpfile" -Dfrontend.skip=true)
fi

cd "$here"
rm -rf out
mkdir -p out
javac -encoding UTF-8 \
  -cp "$backend/target/classes:$(cat "$cpfile")" \
  -d out $(find src -name '*.java')
(cd out && jar cf ../uvs-skeleton.jar com)
echo "[uvs] uvs-skeleton.jar を更新しました（$(stat -c%s uvs-skeleton.jar) バイト）"
echo "[uvs] ⚠️ backend を再起動しないと反映されません"
