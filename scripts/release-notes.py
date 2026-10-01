#!/usr/bin/env python3
"""
リリースノートを作る（.github/workflows/release.yml から呼ぶ）。

前のタグからこのタグまでの main の履歴（--first-parent）を、Conventional Commits の
種別ごとに「新機能」「バグ修正」「改善」に振り分けて Markdown を出力する。
PR のマージコミットは PR タイトル（マージコミット本文の 1 行目）を使うので、
PR 内の途中コミットは並ばない。docs / test / ci / chore などの利用者に見えない変更は載せない。

使い方: python3 scripts/release-notes.py v0.3.5 [owner/repo]
"""
import re
import subprocess
import sys

SECTIONS = [
    ("feat", "新機能"),
    ("fix", "バグ修正"),
    ("perf", "改善"),
]
HIDDEN = {"docs", "test", "ci", "chore", "build", "style", "refactor", "spike", "wip", "revert"}
CONVENTIONAL = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<desc>.+)$")
PR_MERGE = re.compile(r"^Merge pull request #(?P<num>\d+) from ")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def previous_tag(tag):
    try:
        return git("describe", "--tags", "--abbrev=0", "--match", "v*", f"{tag}^").strip()
    except subprocess.CalledProcessError:
        return None


def entries(rev_range):
    log = git("log", "--first-parent", "--reverse", "--format=%P%x1f%s%x1f%b%x1e", rev_range)
    for record in log.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        parents, subject, body = record.split("\x1f", 2)
        parents = parents.split()
        m = PR_MERGE.match(subject)
        if m:
            title = next((l.strip() for l in body.splitlines() if l.strip()), "")
            if title:
                yield f"{title} (#{m.group('num')})"
        elif len(parents) > 1:
            # PR を経ずにローカルでマージしたブランチは、タイトルが無いので中のコミットを並べる。
            merged = git("log", "--no-merges", "--reverse", "--format=%s", f"{parents[0]}..{parents[1]}")
            yield from (l for l in merged.splitlines() if l.strip())
        else:
            yield subject


def main():
    tag = sys.argv[1]
    repo = sys.argv[2] if len(sys.argv) > 2 else "tatsunidas/GRAPHY-Next"
    prev = previous_tag(tag)
    grouped = {key: [] for key, _ in SECTIONS}
    other = []

    for line in entries(f"{prev}..{tag}" if prev else tag):
        m = CONVENTIONAL.match(line)
        if not m:
            other.append(line)
            continue
        kind = m.group("type")
        if kind in HIDDEN:
            continue
        scope = f"**{m.group('scope')}**: " if m.group("scope") else ""
        breaking = "⚠️ 互換性のない変更: " if m.group("bang") else ""
        item = f"- {breaking}{scope}{m.group('desc')}"
        if kind in grouped:
            grouped[kind].append(item)
        else:
            other.append(line)

    out = []
    for key, heading in SECTIONS:
        if grouped[key]:
            out += [f"## {heading}", "", *grouped[key], ""]
    if other:
        out += ["## その他の変更", "", *(f"- {l}" for l in other), ""]
    if not any(grouped.values()) and not other:
        out += ["利用者に見える変更はありません（内部の改善のみ）。", ""]
    if prev:
        out.append(f"**全変更履歴**: https://github.com/{repo}/compare/{prev}...{tag}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
