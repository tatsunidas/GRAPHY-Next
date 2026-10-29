#!/usr/bin/env python3
"""マニュアルに書いた画面の文言が、アプリの日本語の文言と一致しているか照合する。

マニュアルでは、画面に出る文言（メニュー名・ボタン名・項目名）を `**文言**{.ui}` と書く。
その文言が frontend/src/i18n/ja.ts のどれかの値と**完全一致**しなければ失敗する（アプリの文言を変えたのに
マニュアルが古いまま、の検出）。正規化（NFKC など）はしない: 全角・半角や互換漢字の食い違いも不一致として出す。

使い方: python3 scripts/check-docs-labels.py [--docs docs] [--ja frontend/src/i18n/ja.ts]
終了コード: 0=全件一致、1=不一致あり、2=入力の読み取りに失敗（照合できていない）。
"""
import argparse
import json
import pathlib
import re
import sys

ENTRY = re.compile(r'^\s*"(?P<key>[^"\\]+)"\s*:\s*(?P<val>"(?:[^"\\]|\\.)*")\s*,?\s*$')
UI = re.compile(r"\*\*([^*\n]+?)\*\*\{\s*\.ui\s*\}")


def load_labels(ja: pathlib.Path) -> set[str]:
    out: set[str] = set()
    for line in ja.read_text(encoding="utf-8").splitlines():
        m = ENTRY.match(line)
        if m:
            out.add(json.loads(m.group("val")))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default="docs")
    ap.add_argument("--ja", default="frontend/src/i18n/ja.ts")
    a = ap.parse_args()
    try:
        labels = load_labels(pathlib.Path(a.ja))
    except OSError as e:
        print(f"文言の一覧を読めません: {e}", file=sys.stderr)
        return 2
    if len(labels) < 100:
        # 形式が変わって 1 件も拾えないと、全件「不一致」か、逆に何も照合しないまま通ってしまう。
        print(f"ja.ts から文言を {len(labels)} 件しか読めません（形式が変わった可能性）", file=sys.stderr)
        return 2
    checked = 0
    bad: list[str] = []
    for md in sorted(pathlib.Path(a.docs).glob("*.md")):
        for n, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
            for m in UI.finditer(line):
                checked += 1
                if m.group(1) not in labels:
                    bad.append(f"{md}:{n}: 「{m.group(1)}」はアプリの文言にありません")
    for b in bad:
        print(b)
    print(f"照合 {checked} 件・不一致 {len(bad)} 件（アプリの文言 {len(labels)} 件）")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
