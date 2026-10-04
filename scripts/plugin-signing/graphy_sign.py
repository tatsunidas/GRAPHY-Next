#!/usr/bin/env python3
"""
公式プラグインの署名（minisign・公式鍵 98EA7C6BA2D50118）を、開発機 3 台（Linux / Windows / Mac）で
同じ手順で行うためのスクリプト。署名そのものは各プラグインの CI（タグ push）が行う。
このスクリプトは「secrets を入れる」「過去のリリースや手元の zip に署名する」を受け持つ。

鍵とパスフレーズの置き場所（各機・git に入れない）:
  ~/graphy-signing/graphy-plugins.key   秘密鍵（所有者だけ読める権限）
  ~/graphy-signing/graphy-plugins.pub   公開鍵
  ~/graphy-signing/.env                 MINISIGN_PASSWORD=<パスフレーズ>（所有者だけ読める権限）
環境変数 MINISIGN_PASSWORD / MINISIGN_SECRET_KEY_FILE / MINISIGN_PUBLIC_KEY_FILE / MINISIGN_BIN があれば
そちらを優先する。パスフレーズは minisign と gh に stdin でだけ渡し、引数やログには出さない。

使い方:
  python3 scripts/plugin-signing/graphy_sign.py check
  python3 scripts/plugin-signing/graphy_sign.py setup-repo tatsunidas/graphy-next-plugin-xxx
  python3 scripts/plugin-signing/graphy_sign.py sign-release tatsunidas/graphy-next-plugin-xxx v0.1.0 [--upload]
  python3 scripts/plugin-signing/graphy_sign.py sign-file path/to/<id>-<ver>.zip

手順書: fw/plugin-signing-runbook.md
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SIGNING_DIR = Path.home() / "graphy-signing"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
APPLICATION_YML = REPO_ROOT / "backend" / "src" / "main" / "resources" / "application.yml"


class SignError(Exception):
    pass


def load_env_file(path):
    values = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


class Config:
    def __init__(self):
        self.env_file = SIGNING_DIR / ".env"
        file_values = load_env_file(self.env_file)

        def get(name, default=None):
            if name in os.environ:
                return os.environ[name]
            return file_values.get(name, default)

        self.key_file = Path(get("MINISIGN_SECRET_KEY_FILE", str(SIGNING_DIR / "graphy-plugins.key"))).expanduser()
        self.pub_file = Path(get("MINISIGN_PUBLIC_KEY_FILE", str(SIGNING_DIR / "graphy-plugins.pub"))).expanduser()
        self.password = get("MINISIGN_PASSWORD")
        self.password_source = "環境変数" if "MINISIGN_PASSWORD" in os.environ else str(self.env_file)
        self.minisign = get("MINISIGN_BIN") or shutil.which("minisign")

    def require(self):
        problems = []
        if not self.minisign:
            problems.append("minisign が見つかりません（PATH に置くか MINISIGN_BIN で指定）")
        if not self.key_file.is_file():
            problems.append(f"秘密鍵がありません: {self.key_file}")
        if not self.pub_file.is_file():
            problems.append(f"公開鍵がありません: {self.pub_file}")
        if self.password is None:
            problems.append(f"MINISIGN_PASSWORD が未設定です（{self.env_file} に MINISIGN_PASSWORD=... を書く）")
        if problems:
            raise SignError("\n".join(problems))

    def public_key_line(self):
        lines = [l.strip() for l in self.pub_file.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) < 2:
            raise SignError(f"公開鍵の形式が違います: {self.pub_file}")
        return lines[1]


def warn_loose_permissions(path):
    if os.name != "posix" or not path.exists():
        return
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        print(f"⚠ {path} の権限が {oct(mode)} です。chmod 600 にしてください", file=sys.stderr)


def trusted_keys_in_app():
    if not APPLICATION_YML.is_file():
        return None
    return set(re.findall(r'^\s*-\s*"(RW[A-Za-z0-9+/=]+)"', APPLICATION_YML.read_text(encoding="utf-8"), re.M))


def minisign_sign(cfg, target, trusted_comment, sig_path):
    proc = subprocess.run(
        [cfg.minisign, "-S", "-s", str(cfg.key_file), "-m", str(target), "-t", trusted_comment, "-x", str(sig_path)],
        input=(cfg.password + "\n").encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if proc.returncode != 0 or not sig_path.is_file():
        # 出力にパスフレーズは含まれない（minisign は入力を表示しない）
        raise SignError("署名に失敗しました（パスフレーズ違いの可能性）:\n" + proc.stdout.decode("utf-8", "replace").strip())


def minisign_verify(cfg, target, sig_path, pub_file):
    proc = subprocess.run(
        [cfg.minisign, "-V", "-p", str(pub_file), "-m", str(target), "-x", str(sig_path)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise SignError("検証に失敗しました:\n" + out)
    return out


def gh(*args, input_bytes=None):
    proc = subprocess.run(["gh", *args], input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise SignError(f"gh {args[0]} {args[1] if len(args) > 1 else ''} が失敗しました:\n"
                        + proc.stderr.decode("utf-8", "replace").strip())
    return proc.stdout.decode("utf-8", "replace")


def cmd_check(cfg, quiet=False):
    cfg.require()
    warn_loose_permissions(cfg.key_file)
    warn_loose_permissions(cfg.env_file)
    pub = cfg.public_key_line()
    trusted = trusted_keys_in_app()
    if trusted is None:
        print(f"⚠ {APPLICATION_YML} が読めないので、本体の trusted-keys との照合は省きました", file=sys.stderr)
    elif pub not in trusted:
        raise SignError(f"公開鍵 {cfg.pub_file} は本体の trusted-keys に入っていません（公式鍵ではない）")
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "check.txt"
        target.write_text("graphy-sign check\n", encoding="utf-8")
        sig = Path(tmp) / "check.txt.minisig"
        minisign_sign(cfg, target, "graphy-sign check", sig)
        out = minisign_verify(cfg, target, sig, cfg.pub_file)
    if not quiet:
        print(out)
        print(f"OK: 秘密鍵 {cfg.key_file} とパスフレーズ（{cfg.password_source}）で署名し、公式の公開鍵で検証できました")


def repo_minisign_pub(repo):
    try:
        content = json.loads(gh("api", f"repos/{repo}/contents/minisign.pub"))["content"]
    except SignError:
        return None
    text = base64.b64decode(content).decode("utf-8")
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return lines[1] if len(lines) >= 2 else ""


def cmd_setup_repo(cfg, repo):
    # 間違ったパスフレーズを secrets に入れないよう、先に手元で署名できることを確かめる
    cmd_check(cfg, quiet=True)
    gh("secret", "set", "MINISIGN_SECRET_KEY", "-R", repo, input_bytes=cfg.key_file.read_bytes())
    print(f"登録: {repo} MINISIGN_SECRET_KEY")
    if cfg.password:
        gh("secret", "set", "MINISIGN_PASSWORD", "-R", repo, input_bytes=cfg.password.encode("utf-8"))
        print(f"登録: {repo} MINISIGN_PASSWORD")
    else:
        print("パスフレーズが空なので MINISIGN_PASSWORD は登録しません（パスフレーズの無い鍵）")
    repo_pub = repo_minisign_pub(repo)
    if repo_pub is None:
        print(f"⚠ {repo} に minisign.pub がありません。{cfg.pub_file} を minisign.pub としてコミットしてください")
    elif repo_pub != cfg.public_key_line():
        print(f"⚠ {repo} の minisign.pub は公式鍵と違います")
    else:
        print(f"確認: {repo} の minisign.pub は公式鍵と一致")


def cmd_sign_release(cfg, repo, tag, upload):
    cmd_check(cfg, quiet=True)
    release = json.loads(gh("release", "view", tag, "-R", repo, "--json", "assets,isDraft"))
    names = [a["name"] for a in release["assets"]]
    # 本体（PluginManagerService.findZipAsset）と同じく、最初の .zip 資産を対象にする
    zips = [n for n in names if n.lower().endswith(".zip")]
    if not zips:
        raise SignError(f"{repo} {tag} に .zip 資産がありません")
    zip_name = zips[0]
    if zip_name + ".minisig" in names:
        print(f"済: {repo} {tag} には {zip_name}.minisig が既にあります（何もしません）")
        return
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        patterns = [zip_name] + ([zip_name + ".sha256"] if zip_name + ".sha256" in names else [])
        args = ["release", "download", tag, "-R", repo, "-D", str(tmpdir)]
        for p in patterns:
            args += ["-p", p]
        gh(*args)
        zip_path = tmpdir / zip_name
        actual = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        if zip_name + ".sha256" in names:
            expected = (tmpdir / (zip_name + ".sha256")).read_text(encoding="utf-8").split()[0].lower()
            if expected != actual:
                raise SignError(f"sha256 が一致しません: 資産 {expected} / 実物 {actual}")
            print(f"sha256 一致: {actual}")
        else:
            print(f"⚠ {zip_name}.sha256 がありません（sha256 照合なし）: {actual}")
        sig = tmpdir / (zip_name + ".minisig")
        # CI（release.yml）と同じ trusted comment（<id>-<ver>）
        minisign_sign(cfg, zip_path, zip_name[:-4], sig)
        print(minisign_verify(cfg, zip_path, sig, cfg.pub_file))
        files = [sig]
        if "minisign.pub" not in names:
            pub_copy = tmpdir / "minisign.pub"
            shutil.copyfile(cfg.pub_file, pub_copy)
            files.append(pub_copy)
        if not upload:
            print(f"dry-run: {repo} {tag} に {', '.join(f.name for f in files)} を添付できます（--upload で実行）")
            return
        gh("release", "upload", tag, "-R", repo, *[str(f) for f in files])
        print(f"添付: {repo} {tag} ← {', '.join(f.name for f in files)}")


def cmd_sign_file(cfg, zip_path):
    cmd_check(cfg, quiet=True)
    zip_path = Path(zip_path)
    if not zip_path.is_file():
        raise SignError(f"ファイルがありません: {zip_path}")
    sig = zip_path.with_name(zip_path.name + ".minisig")
    if sig.exists():
        raise SignError(f"{sig} が既にあります（消してからやり直してください）")
    minisign_sign(cfg, zip_path, zip_path.stem, sig)
    print(minisign_verify(cfg, zip_path, sig, cfg.pub_file))
    print(f"作成: {sig}")


def main():
    parser = argparse.ArgumentParser(description="GRAPHY-Next 公式プラグインの署名（minisign）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="鍵・パスフレーズ・公式鍵との一致を確かめる")
    p = sub.add_parser("setup-repo", help="リポジトリに MINISIGN_SECRET_KEY / MINISIGN_PASSWORD を登録する")
    p.add_argument("repo")
    p = sub.add_parser("sign-release", help="既存の GitHub Release の zip に署名を付ける（既定は dry-run）")
    p.add_argument("repo")
    p.add_argument("tag")
    p.add_argument("--upload", action="store_true", help="署名と minisign.pub を Release に添付する")
    p = sub.add_parser("sign-file", help="手元の zip に .minisig を作る")
    p.add_argument("zip")
    args = parser.parse_args()
    cfg = Config()
    try:
        if args.cmd == "check":
            cmd_check(cfg)
        elif args.cmd == "setup-repo":
            cmd_setup_repo(cfg, args.repo)
        elif args.cmd == "sign-release":
            cmd_sign_release(cfg, args.repo, args.tag, args.upload)
        elif args.cmd == "sign-file":
            cmd_sign_file(cfg, args.zip)
    except SignError as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
