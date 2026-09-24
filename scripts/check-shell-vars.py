#!/usr/bin/env python3
"""シェルスクリプトの `$VAR` が、直後のマルチバイト文字に食われていないかを検査する。

背景（2026-09-25・v0.3.0 のリリースが実際に止まった）:
  echo "... （host=$HOST_NATIVE）"
は Linux の bash 5 では意図どおり展開されるが、**macOS の bash 3.2 では
`）` の先頭バイトを変数名の一部として読む**。`set -u` と合わさって

  fetch-dcm4che-tools.sh: line 155: HOST_NATIVE?: unbound variable

で落ちる。日本語のメッセージを書く限り必ず踏むので、機械で止める。

🔴 手元（Linux）では再現しない。だから CI で見る。
直し方は `${VAR}` と波括弧で囲うだけ。
"""
import pathlib
import re
import subprocess
import sys

# $VAR の直後が非 ASCII（＝マルチバイト文字の先頭バイト）。
PATTERN = re.compile(rb"\$([A-Za-z_][A-Za-z0-9_]*)(?=[\x80-\xff])")


def main() -> int:
    files = subprocess.run(
        ["git", "ls-files", "*.sh"], capture_output=True, text=True, check=True
    ).stdout.split()
    found = 0
    for name in files:
        data = pathlib.Path(name).read_bytes()
        for lineno, line in enumerate(data.split(b"\n"), 1):
            for m in PATTERN.finditer(line):
                var = m.group(1).decode()
                print(f"{name}:{lineno}: ${var} の直後がマルチバイト文字です → ${{{var}}} と書いてください")
                found += 1
    if found:
        print(f"\n{found} 件。macOS の bash 3.2 で 'unbound variable' になります。", file=sys.stderr)
        return 1
    print(f"シェル変数の展開: 問題なし（{len(files)} ファイル）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
