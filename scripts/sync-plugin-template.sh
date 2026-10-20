#!/usr/bin/env bash
# examples/plugin-template/（正本）を、公開のテンプレートリポジトリ（既定 tatsunidas/graphy-next-plugin-template）の main へ反映する。
#
#   scripts/sync-plugin-template.sh            差分を表示するだけ（乾燥実行。何も書き込まない）
#   scripts/sync-plugin-template.sh --apply    差分があれば commit して push する
#
# 環境変数 TEMPLATE_REMOTE で反映先を変えられる（既定 https://github.com/tatsunidas/graphy-next-plugin-template.git。試験では file パスの bare リポジトリ）。
# 正本は本体の examples/plugin-template/ で、テンプレートリポジトリ側は直接編集しない（次の同期で上書きされる）。
set -euo pipefail

apply=0
case "${1:-}" in
  "") ;;
  --apply) apply=1 ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

repo_root=$(git rev-parse --show-toplevel)
src="$repo_root/examples/plugin-template"
remote=${TEMPLATE_REMOTE:-https://github.com/tatsunidas/graphy-next-plugin-template.git}
[ -d "$src" ] || { echo "正本が無い: $src" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet "$remote" "$work/t"
cd "$work/t"
git checkout --quiet main 2>/dev/null || git checkout --quiet -b main

# .git 以外を空にして正本を写す（正本で消したファイルをテンプレート側からも消すため）
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$src"/. .

git add -A
if git diff --cached --quiet; then
  echo "差分なし: テンプレートは正本と一致している"
  exit 0
fi

git diff --cached --stat
if [ "$apply" -ne 1 ]; then
  echo "（乾燥実行。反映するには --apply）"
  exit 0
fi

src_rev=$(git -C "$repo_root" rev-parse --short HEAD)
git commit --quiet -m "本体 examples/plugin-template から同期（${src_rev}）"
git push --quiet origin main
echo "反映した: $(git rev-parse --short HEAD)"
