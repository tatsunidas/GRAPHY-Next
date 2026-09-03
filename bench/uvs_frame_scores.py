#!/usr/bin/env python3
"""UVS の色判定（CPR）・静止判定（MAD）の**独立参照実装**。

なぜ要るのか
------------
プラグイン（Java）の移植が正しいかを確かめる相手が要る。元アプリを動かして比べるのが
理想だが、それには別リポジトリのビルドと ONNX の再生成が要る。

🔑 そこで **仕様（`fw/uvs-plugin-design.md` §5 の定数）から別実装を起こす**。
Java のコードを写すのではなく、**同じ約束から独立に書く**ので、
「両方が同じように間違える」ことが起きにくい。

🔴 **Java の `Random` を仕様から実装している**のが要点。
`java.util.Random` は線形合同法で**規格に明記されている**ので、Python から厳密に再現できる:

    seed = (seed ^ 0x5DEECE66D) & ((1 << 48) - 1)
    next(bits): seed = (seed * 0x5DEECE66D + 0xB) & ((1 << 48) - 1); return seed >> (48 - bits)

これが一致しなければサンプル点が変わり、CPR も MAD も変わる。

使い方
------
    python3 bench/uvs_frame_scores.py VIDEO.mp4 --width 720 --height 440 [--limit 60]

出力は JSON（`{"cpr": [...], "mad": [...]}`）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

import numpy as np

SAMPLING_POINTS = 300
RANDOM_SEED = 76
COLOR_THRESHOLD = 30.0


class JavaRandom:
    """`java.util.Random` の線形合同法（規格どおり）。"""

    MULT = 0x5DEECE66D
    ADD = 0xB
    MASK = (1 << 48) - 1

    def __init__(self, seed: int) -> None:
        self.seed = (seed ^ self.MULT) & self.MASK

    def _next(self, bits: int) -> int:
        self.seed = (self.seed * self.MULT + self.ADD) & self.MASK
        return self.seed >> (48 - bits)

    def next_int(self, bound: int) -> int:
        """`nextInt(bound)`。⚠️ **2 の冪と一般の場合で分岐がある**（規格どおり）。"""
        if bound <= 0:
            raise ValueError("bound must be positive")
        if (bound & -bound) == bound:  # 2 の冪
            return (bound * self._next(31)) >> 31
        while True:
            bits = self._next(31)
            val = bits % bound
            # 剰余の偏りを避けるための棄却（ここを省くと稀にずれる）
            if bits - val + (bound - 1) < (1 << 31):
                return val


def sampling_points(width: int, height: int, requested: int, seed: int):
    """色用と静止用の 2 系統。

    🔴 **同じシードでも別の点列になる**——消費の仕方が違うため
    （色は `nextInt(total)` を n 回、静止は `nextInt(w)` と `nextInt(h)` を交互に n 回）。
    """
    total = width * height
    count = min(total, requested)

    r1 = JavaRandom(seed)
    pixel_index = np.array([r1.next_int(total) for _ in range(count)], dtype=np.int64)

    r2 = JavaRandom(seed)
    xs = np.empty(count, dtype=np.int64)
    ys = np.empty(count, dtype=np.int64)
    for i in range(count):
        xs[i] = r2.next_int(width)
        ys[i] = r2.next_int(height)
    return pixel_index, ys * width + xs


def frames(video: str, width: int, height: int, limit: int):
    """ffmpeg で rgb24 のフレームを流す。"""
    n = width * height * 3
    cmd = ["ffmpeg", "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    count = 0
    try:
        while limit <= 0 or count < limit:
            buf = proc.stdout.read(n)
            if not buf or len(buf) < n:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(height * width, 3)
            count += 1
    finally:
        proc.kill()
        proc.wait()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("video")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--limit", type=int, default=0, help="先頭 N フレームだけ（0 で全部）")
    args = ap.parse_args()

    color_idx, static_idx = sampling_points(args.width, args.height, SAMPLING_POINTS, RANDOM_SEED)

    cpr: list[float] = []
    mad: list[float] = []
    prev = None
    for f in frames(args.video, args.width, args.height, args.limit):
        f = f.astype(np.int32)
        if prev is not None:
            # 🔴 MAD は**四捨五入した整数**のグレー値で引く（`gray()` と同じ）。
            g_prev = np.floor(prev[static_idx].sum(axis=1) / 3.0 + 0.5).astype(np.int64)
            g_cur = np.floor(f[static_idx].sum(axis=1) / 3.0 + 0.5).astype(np.int64)
            mad.append(float(np.abs(g_prev - g_cur).mean()))
            # CPR は「前のフレーム」に対して出す（Java 側が pair[0] を使うのと揃える）。
            sel = prev[color_idx]
            rng = sel.max(axis=1) - sel.min(axis=1)
            cpr.append(float((rng > COLOR_THRESHOLD).sum() / len(color_idx)))
        prev = f

    if mad:
        mad.append(mad[-1])  # 最終フレームは直前を複製（Java 側と同じ）

    json.dump(
        {
            "frames": len(cpr),
            "samplingPoints": len(color_idx),
            "seed": RANDOM_SEED,
            "colorThreshold": COLOR_THRESHOLD,
            "cpr": cpr,
            "mad": mad,
        },
        sys.stdout,
    )
    print()


if __name__ == "__main__":
    main()
