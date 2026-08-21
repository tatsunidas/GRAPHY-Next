#!/usr/bin/env bash
# GRAPHY-Next Benchmark
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# GNBP のファントムを、動いている GRAPHY の保管庫へ C-STORE で入れる。
#
#   bash bench/store-scu.sh phantom/GNBP-5N-t20-id-tex phantom/GNBP-5N-t25-id-tex
#
# 送り先の既定は GRAPHYNEXT@127.0.0.1:11112（standalone の SCP）。
# アプリ（または backend）が起動している必要がある。
#
# クラスパスは backend が既に依存している dcm4che を ~/.m2 から拾う。dcm4che の CLI を
# 別途入れる必要は無い。JDK 21 以降なら単一ファイルのまま実行できる。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
m2="${M2_REPO:-$HOME/.m2/repository}"

find_jar() {
  # 最新版を 1 つ選ぶ（sources / javadoc は除く）。
  find "$m2/$1" -name "$2-*.jar" ! -name "*-sources.jar" ! -name "*-javadoc.jar" 2>/dev/null \
    | sort -V | tail -1
}

core="$(find_jar org/dcm4che/dcm4che-core dcm4che-core)"
net="$(find_jar org/dcm4che/dcm4che-net dcm4che-net)"
dict="$(find_jar org/dcm4che/dcm4che-dict dcm4che-dict)"
slf4j="$(find_jar org/slf4j/slf4j-api slf4j-api)"

for jar in "$core" "$net" "$slf4j"; do
  if [ -z "$jar" ] || [ ! -f "$jar" ]; then
    echo "dcm4che / slf4j の jar が ~/.m2 に見つかりません。" >&2
    echo "先に 'cd backend && mvn -q -Dfrontend.skip=true compile' を 1 度通してください。" >&2
    exit 2
  fi
done

# ⚠ Git Bash のパスは `/c/Users/...` で、Windows の java は理解しない。区切り文字も ';' になる。
# cygpath を通さないと「jar は見つかっているのにクラスが無い」という分かりにくい失敗になる。
sep=":"
win=0
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) sep=";"; win=1 ;;
esac
towin() { if [ "$win" = "1" ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

cp="$(towin "$core")$sep$(towin "$net")$sep$(towin "$slf4j")"
[ -n "$dict" ] && cp="$cp$sep$(towin "$dict")"

exec java -cp "$cp" "$(towin "$here/StoreScu.java")" "$@"
