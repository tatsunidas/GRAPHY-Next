#!/usr/bin/env python3
"""
リリースノートを作る（.github/workflows/release.yml から呼ぶ）。

前回の公開済みリリースからこのタグまでの main の履歴（--first-parent）を、Conventional Commits の
種別ごとに「新機能」「バグ修正」「改善」に振り分けて Markdown を出力する。
PR のマージコミットは PR タイトル（マージコミット本文の 1 行目）を使うので、
PR 内の途中コミットは並ばない。docs / test / ci / chore などの利用者に見えない変更は載せない。

.github/release-highlights/<タグ>.md があれば、その内容を先頭に付ける（大きな版で
「何が変わったか」を人の言葉で伝えるため。自動の一覧はその下に続く）。

使い方: python3 scripts/release-notes.py v0.3.5 [owner/repo]
"""
import re
import subprocess
import sys
from pathlib import Path

HIGHLIGHTS_DIR = Path(__file__).resolve().parent.parent / ".github" / "release-highlights"

SECTIONS = [
    ("feat", "新機能"),
    ("fix", "バグ修正"),
    ("perf", "改善"),
]
HIDDEN = {"docs", "test", "ci", "chore", "build", "style", "refactor", "spike", "wip", "revert", "automator"}
# docs+ci(release): のように種別を + で重ねたものも受ける。
CONVENTIONAL = re.compile(r"^(?P<type>[a-z]+(?:\+[a-z]+)*)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<desc>.+)$")
# Conventional Commits を使う前の初期の題名（"fix installer bug" / "add website" / "release 0.1.4"）。
LEGACY = [
    (re.compile(r"^fix(es|ed)?\b", re.I), "fix"),
    (re.compile(r"^add(s|ed)?\b", re.I), "feat"),
    (re.compile(r"^release\b", re.I), None),
]
PR_MERGE = re.compile(r"^Merge pull request #(?P<num>\d+) from ")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def published_tags(repo):
    """公開中（下書きでない）リリースのタグ。gh が使えなければ None。"""
    try:
        out = subprocess.run(
            ["gh", "api", "--paginate", f"repos/{repo}/releases",
             "--jq", ".[] | select(.draft | not) | .tag_name"],
            check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.split()


def previous_tag(tag, repo):
    """
    前回の**公開済み**リリースのタグ。不具合で下書きに戻した版（v0.3.0〜0.3.4 など）は
    利用者に届いていないので、その変更もこの版のノートに含める。
    """
    published = published_tags(repo)
    if published:
        candidates = [
            t for t in published
            if t != tag and subprocess.run(
                ["git", "merge-base", "--is-ancestor", t, tag], capture_output=True).returncode == 0
        ]
        if candidates:
            return min(candidates, key=lambda t: int(git("rev-list", "--count", f"{t}..{tag}")))
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
    prev = previous_tag(tag, repo)
    grouped = {key: [] for key, _ in SECTIONS}
    other = []

    for line in entries(f"{prev}..{tag}" if prev else tag):
        m = CONVENTIONAL.match(line)
        if not m:
            legacy = next((kind for pattern, kind in LEGACY if pattern.match(line)), "other")
            if legacy in grouped:
                grouped[legacy].append(f"- {line}")
            elif legacy == "other" and len(line.split()) > 1:
                # "update" / "misc" のような 1 語だけの題名は内容が分からないので載せない。
                other.append(line)
            continue
        kinds = m.group("type").split("+")
        if all(k in HIDDEN for k in kinds):
            continue
        kind = next(k for k in kinds if k not in HIDDEN)
        scope = f"**{m.group('scope')}**: " if m.group("scope") else ""
        breaking = "⚠️ 互換性のない変更: " if m.group("bang") else ""
        item = f"- {breaking}{scope}{m.group('desc')}"
        if kind in grouped:
            grouped[kind].append(item)
        else:
            other.append(line)

    out = []
    highlights = HIGHLIGHTS_DIR / f"{tag}.md"
    if highlights.is_file():
        out += [highlights.read_text(encoding="utf-8").strip(), ""]
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
