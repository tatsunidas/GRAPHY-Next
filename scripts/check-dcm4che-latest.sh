#!/usr/bin/env bash
#
# Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
# Author: Tatsuaki Kobayashi
#
# リリース前の検査: backend/pom.xml が固定している dcm4che が「取り込める最新の安定版」か。
#   - THIRD-PARTY-NOTICES.md の版が pom と違う → 失敗
#   - GitHub の最新リリースが pom より新しく、Maven の jar と SourceForge の配布 zip が両方ある → 失敗
#     （どちらかが無い版は、まだ取り込めないので警告だけで通す）
#   - GitHub / Maven / SourceForge に届かない → 失敗（検査を黙って飛ばさない）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POM="$ROOT/backend/pom.xml"
NOTICES="$ROOT/THIRD-PARTY-NOTICES.md"

pom_v="$(sed -n 's#.*<dcm4che.version>\(.*\)</dcm4che.version>.*#\1#p' "$POM" | head -1)"
notices_v="$(sed -n 's#^| dcm4che (.*) | \([0-9][0-9.]*\) | .*#\1#p' "$NOTICES" | head -1)"
[ -n "$pom_v" ] || { echo "pom から dcm4che.version を読めません。" >&2; exit 1; }
[ -n "$notices_v" ] || { echo "THIRD-PARTY-NOTICES.md の dcm4che の行から版を読めません。" >&2; exit 1; }

fail=0
if [ "$pom_v" != "$notices_v" ]; then
  echo "::error::THIRD-PARTY-NOTICES.md の dcm4che ($notices_v) が pom ($pom_v) と違います。" >&2
  fail=1
fi

latest="$(curl -fsSL --retry 3 ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
  https://api.github.com/repos/dcm4che/dcm4che/releases/latest \
  | sed -n 's#.*"tag_name": *"\([^"]*\)".*#\1#p' | head -1)" || latest=""
[ -n "$latest" ] || { echo "::error::GitHub から dcm4che の最新リリースを取得できません（検査できないため中止）。" >&2; exit 1; }

echo "dcm4che: pom=$pom_v  notices=$notices_v  latest(GitHub)=$latest"

newest="$(printf '%s\n%s\n' "$pom_v" "$latest" | sort -V | tail -1)"
if [ "$latest" != "$pom_v" ] && [ "$newest" = "$latest" ]; then
  maven_code="$(curl -s -o /dev/null -w '%{http_code}' --retry 3 -I \
    "https://maven.dcm4che.org/org/dcm4che/dcm4che-core/$latest/dcm4che-core-$latest.jar")"
  sf_code="$(curl -s -o /dev/null -w '%{http_code}' --retry 3 -IL \
    "https://sourceforge.net/projects/dcm4che/files/dcm4che3/$latest/dcm4che-$latest-bin.zip/download")"
  if [ "$maven_code" = "200" ] && [ "$sf_code" = "200" ]; then
    echo "::error::dcm4che $latest が公開されています（pom は $pom_v）。backend/pom.xml の dcm4che.version と THIRD-PARTY-NOTICES.md を $latest に上げてください。" >&2
    fail=1
  else
    echo "::warning::dcm4che $latest は GitHub にありますが、取り込めません（Maven=$maven_code, SourceForge=$sf_code）。pom は $pom_v のまま通します。" >&2
  fi
fi

[ "$fail" -eq 0 ] && echo "OK: dcm4che $pom_v は取り込める最新の安定版です。"
exit "$fail"
