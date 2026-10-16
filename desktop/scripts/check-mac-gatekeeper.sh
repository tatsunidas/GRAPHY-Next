#!/usr/bin/env bash
# できた Mac 版の dmg を「ブラウザで落とした状態」（隔離の印付き）にして、署名と macOS の判定を確かめる。
# リリースのワークフロー（.github/workflows/release.yml）が公開の前に走らせる。不合格なら exit 1＝この dmg は公開されない。
#
# 🚨 2026-10-16: v0.4.0 の Mac 版は app 全体の署名が無く、macOS が「失効」「既知のマルウェア」と判定して開けなかった。
#    CI の実機検査（installedSmoke）は隔離の印が付かないので Gatekeeper を通らず、これに気付けない（fw/release-checklist.md）。
#
# 使い方: bash desktop/scripts/check-mac-gatekeeper.sh <dist ディレクトリ | dmg>...
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "::error::macOS でだけ動きます"; exit 1; }

dmgs=()
for a in "$@"; do
  if [ -d "$a" ]; then
    while IFS= read -r f; do dmgs+=("$f"); done < <(find "$a" -maxdepth 1 -name '*.dmg')
  else
    dmgs+=("$a")
  fi
done
[ "${#dmgs[@]}" -gt 0 ] || { echo "::error::dmg が見つかりません: $*"; exit 1; }

fail=0
for dmg in "${dmgs[@]}"; do
  echo "=== $(basename "$dmg")"
  work=$(mktemp -d)
  cp "$dmg" "$work/q.dmg"
  xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;" "$work/q.dmg"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$work/mnt" "$work/q.dmg"
  app=$(find "$work/mnt" -maxdepth 1 -name '*.app' | head -1)
  if [ -z "$app" ]; then
    echo "::error::$(basename "$dmg") の中に .app がありません"; hdiutil detach -quiet "$work/mnt"; fail=1; continue
  fi
  ditto "$app" "$work/$(basename "$app")"
  hdiutil detach -quiet "$work/mnt"
  app="$work/$(basename "$app")"
  xattr -p com.apple.quarantine "$app" >/dev/null || { echo "::error::隔離の印が付いていません（検査の前提が崩れています）"; fail=1; continue; }

  if ! codesign --verify --deep --strict --verbose=2 "$app"; then
    echo "::error::$(basename "$dmg"): codesign --verify --deep --strict が不合格"; fail=1
  fi
  info=$(codesign -dv "$app" 2>&1 || true)
  echo "$info" | grep -E 'Signature=|Sealed Resources|Info.plist|flags=' || true
  if ! echo "$info" | grep -q 'Sealed Resources version='; then
    echo "::error::$(basename "$dmg"): app 全体の署名（Sealed Resources）がありません"; fail=1
  fi

  if command -v syspolicy_check >/dev/null; then
    verdict=$(syspolicy_check distribution "$app" 2>&1 || true)
    echo "--- syspolicy_check（見出しだけ）"
    echo "$verdict" | grep -E '^[A-Z][A-Za-z ]+$' || echo "(なし)"
    if echo "$verdict" | grep -q -E 'Known Malware|revoked'; then
      echo "::error::$(basename "$dmg"): macOS がマルウェア・失効と判定しました"; fail=1
    fi
  else
    echo "::warning::syspolicy_check がありません（macOS 14 より前）。macOS の判定は見ていません。"
  fi
  rm -rf "$work"
done
exit "$fail"
