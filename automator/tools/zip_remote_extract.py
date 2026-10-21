"""HTTP の Range が使える ZIP から、指定したメンバーだけを取り出す（全体を落とさない）。

使い方:
  python -I zip_remote_extract.py --url <URL> --list [--grep REGEX]
  python -I zip_remote_extract.py --url <URL> --out-dir <dir> --member <name> [--member <name> ...]
取り出したファイルの sha256 を表示する。サイズが想定と違えば止まる（途中切れを合格にしない）。
"""
import argparse
import hashlib
import http.client
import io
import os
import re
import sys
import urllib.request
import zipfile


class HttpFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url = url
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(req) as r:
            self.size = int(r.headers["Content-Range"].split("/")[1])
            self.final = r.geturl()
        self.pos = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)

    def read(self, n=-1):
        if n < 0 or self.pos + n > self.size:
            n = self.size - self.pos
        if n <= 0:
            return b""
        out = bytearray()
        while len(out) < n:
            lo = self.pos + len(out)
            hi = self.pos + n - 1
            req = urllib.request.Request(self.final, headers={"Range": f"bytes={lo}-{hi}"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    chunk = r.read()
            except http.client.IncompleteRead as e:
                chunk = e.partial  # 途中で切れた分は取り込み、続きを次の Range で取り直す
            if not chunk:
                raise IOError("Range の応答が空です")
            out += chunk
        self.pos += n
        return bytes(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--grep")
    ap.add_argument("--out-dir")
    ap.add_argument("--member", action="append", default=[])
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BufferedReader(HttpFile(a.url), buffer_size=1 << 20))
    if a.list:
        for i in z.infolist():
            if not a.grep or re.search(a.grep, i.filename):
                print(i.file_size, i.filename)
        return
    if not a.out_dir:
        sys.exit("--out-dir が要ります")
    for m in a.member:
        info = z.getinfo(m)
        dst = os.path.join(a.out_dir, m)
        if os.path.exists(dst) and os.path.getsize(dst) == info.file_size:
            print(m, info.file_size, "（取り出し済み。サイズ一致）")
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        h = hashlib.sha256()
        n = 0
        with z.open(info) as src, open(dst, "wb") as f:
            while chunk := src.read(1 << 20):
                f.write(chunk)
                h.update(chunk)
                n += len(chunk)
        if n != info.file_size:
            sys.exit(f"サイズが合いません: {m} {n} != {info.file_size}")
        print(m, n, h.hexdigest())


if __name__ == "__main__":
    main()
