#!/bin/bash
# pluginThirdPartyCheck.ts の負例用リリース（攻撃者の操作の再現）を作る補助。検査用リポジトリの Release に添える資産を w<版>/dist/ に出す。
#   使い方: pluginThirdPartyFixture.sh <検査用リポジトリを clone したフォルダ> <鍵のフォルダ（A.key B.key A.pub B.pub）> <版> <署名: A|B|none> <公開鍵: A|B|none> <改ざん: yes|no>
#   例: 0.2.0 A A yes（改ざん）/ 0.2.1 B A no（別の鍵で署名）/ 0.2.2 none none no（署名を剥がす）/ 0.2.3 B B no（鍵ごと差し替え）
# 鍵は検査専用の使い捨て（公式鍵は使わない）。Release への添付は `gh release create v<版> -R <repo> w<版>/dist/*`。
set -euo pipefail
repo=$1; keys=$2; v=$3; sign=$4; pub=$5; tamper=$6
out=${PLUGIN_E2E_OUT:-./w$v}
rm -rf "$out" && mkdir -p "$out/pkg" "$out/dist"
jq --arg v "$v" '.version=$v' "$repo/plugin.json" > "$out/pkg/plugin.json"
cp "$repo/ui.js" "$out/pkg/ui.js"
n=$(jq -r .id "$repo/plugin.json")-$v
(cd "$out/pkg" && zip -q -r "../dist/$n.zip" .)
(cd "$out/dist" && sha256sum "$n.zip" > "$n.zip.sha256")
if [ "$sign" != none ]; then
  minisign -S -s "$keys/$sign.key" -m "$out/dist/$n.zip" -t "$n" -x "$out/dist/$n.zip.minisig" </dev/null >/dev/null
fi
if [ "$pub" != none ]; then cp "$keys/$pub.pub" "$out/dist/minisign.pub"; fi
if [ "$tamper" = yes ]; then
  # sha256・署名は正規の zip のまま、zip の中身だけ差し替える
  echo "// tampered" >> "$out/pkg/ui.js"
  rm "$out/dist/$n.zip"; (cd "$out/pkg" && zip -q -r "../dist/$n.zip" .)
fi
ls "$out/dist"
