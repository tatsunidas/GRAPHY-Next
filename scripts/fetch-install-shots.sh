#!/usr/bin/env bash
# release.yml の install-shots ジョブが撮った画面を、docs/images/install/ に取り込む。
#   使い方: bash scripts/fetch-install-shots.sh <run-id>
# 取り込んだら、画像を目で見てから PR にする（fw/release-checklist.md）。
set -euo pipefail
RUN="${1:?run-id を指定してください（gh run list -w release.yml）}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/docs/images/install"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for os in macos-latest windows-latest ubuntu-latest; do
  if gh run download "$RUN" -n "install-shots-$os" -D "$TMP/$os"; then
    echo "== $os"; cat "$TMP/$os/report.txt" 2>/dev/null || echo "(report.txt なし)"
  else
    echo "== $os: Artifact が取れません（撮影の失敗か、期限切れ）"
  fi
done
mkdir -p "$DEST"
shopt -s nullglob
pngs=("$TMP"/*/{mac,win,linux}-*.png)
(( ${#pngs[@]} )) || { echo "取り込む画像がありません"; exit 1; }
cp -f "${pngs[@]}" "$DEST/"
echo "→ ${#pngs[@]} 枚を $DEST に置きました"
