#!/usr/bin/env bash
# 自動更新の対象のインストーラ（Windows の .exe・Linux の .AppImage）を minisign で署名し、検証する。
# アプリ（desktop/appUpdate.js）は、この署名（公式鍵 update-trusted-keys.json）と trusted comment
# `graphy-next v<版> <ファイル名>` を確かめてから実行する。trusted comment が違えば拒否される（ダウングレード対策）。
#
# 使い方: sign-installers.sh <インストーラのあるフォルダ> <版（例 0.6.2）> <official|rehearsal>
#   official  タグのリリース。環境変数 MINISIGN_SECRET_KEY（鍵ファイルの中身）と MINISIGN_PASSWORD（無ければ空）が**必須**。
#             無いときは失敗する（署名なしで黙ってリリースを出さない）。署名後、公式の公開鍵で検証する。
#   rehearsal 予行演習。使い捨ての鍵を作って署名・検証する（署名の仕組みが動くことの確認。**公式の署名ではない**）。
# 署名は <ファイル>.minisig としてフォルダに作る。.exe と .AppImage が 1 つも無ければ失敗する。
#
# 署名は ubuntu のランナーで行う（minisign の Windows 版はパスワードをコンソールから読み、CI の標準入力渡しが効かない恐れがある。
# プラグインの CI と同じ方式）。
set -euo pipefail

dist="${1:?使い方: sign-installers.sh <フォルダ> <版> <official|rehearsal>}"
ver="${2:?版が要ります}"
mode="${3:?official か rehearsal}"
here="$(cd "$(dirname "$0")/.." && pwd)"
MS="${MINISIGN_BIN:-minisign}"
command -v "$MS" >/dev/null || { echo "::error::minisign が見つかりません"; exit 1; }
[[ "$mode" == official || "$mode" == rehearsal ]] || { echo "::error::mode は official か rehearsal: $mode"; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 対象（この版の名前に一致するものだけ）
targets=()
for name in "GRAPHY-Next.Setup.${ver}.exe" "GRAPHY-Next-${ver}.AppImage"; do
  [[ -f "$dist/$name" ]] && targets+=("$name")
done
((${#targets[@]})) || { echo "::error::$dist に GRAPHY-Next.Setup.${ver}.exe も GRAPHY-Next-${ver}.AppImage もありません（版とファイル名を確認）"; exit 1; }

if [[ "$mode" == official ]]; then
  [[ -n "${MINISIGN_SECRET_KEY:-}" ]] || { echo "::error::MINISIGN_SECRET_KEY が未設定です。リリースの署名ができません（graphy_sign.py setup-repo で登録）。署名なしでは出しません。"; exit 1; }
  printf '%s' "$MINISIGN_SECRET_KEY" > "$tmp/key"
  chmod 600 "$tmp/key"
  # 検証に使う公式の公開鍵（TRUSTED_KEYS_FILE はテスト用の差し替え口。リリースの CI では設定しない）
  keys_file="${TRUSTED_KEYS_FILE:-$here/update-trusted-keys.json}"
  verify_args=(-P "$(node -p "require(process.argv[1]).keys[0]" "$keys_file")")
  echo "署名: 公式鍵（update-trusted-keys.json）で検証します"
else
  "$MS" -G -f -W -p "$tmp/e.pub" -s "$tmp/key" >/dev/null
  verify_args=(-p "$tmp/e.pub")
  echo "予行演習: 使い捨ての鍵で署名・検証します（公式の署名ではありません）"
fi

for name in "${targets[@]}"; do
  sig="$dist/$name.minisig"
  comment="graphy-next v${ver} ${name}"
  rm -f "$sig"
  printf '%s\n' "${MINISIGN_PASSWORD:-}" | "$MS" -S -s "$tmp/key" -m "$dist/$name" -x "$sig" -t "$comment" >/dev/null
  [[ -s "$sig" ]] || { echo "::error::署名ができませんでした: $name"; exit 1; }

  # アルゴリズムは prehashed の "ED" であること（旧形式 "Ed" はアプリが受け付けない。minisign 0.10 未満は既定が違う）
  algo="$(sed -n '2p' "$sig" | node -e 'process.stdin.once("data",d=>{console.log(Buffer.from(d.toString().trim(),"base64").subarray(0,2).toString("ascii"))})')"
  [[ "$algo" == ED ]] || { echo "::error::署名のアルゴリズムが ED ではありません（$algo）: $name"; exit 1; }
  # trusted comment が期待どおりか
  got="$(sed -n '3p' "$sig" | sed 's/^trusted comment: //')"
  [[ "$got" == "$comment" ]] || { echo "::error::trusted comment が違います: '$got' != '$comment'"; exit 1; }
  # 検証（official は公式の公開鍵。鍵と secrets が食い違っていればここで落ちる）
  "$MS" -V "${verify_args[@]}" -m "$dist/$name" -x "$sig" >/dev/null || { echo "::error::署名の検証に失敗しました: $name"; exit 1; }
  echo "  OK $name  (alg=$algo, trusted comment='$got')"
done
echo "署名: ${#targets[@]} 件"
