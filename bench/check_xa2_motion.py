#!/usr/bin/env python3
# GRAPHY-Next Benchmark (GNBP-XA-2 motion check)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
"""GNBP-XA-2 に注入した体動が、**画像から本当に取り戻せるか**を確かめる。

`fw/angio-design.md` §6.4 / A2。

なぜ要るのか
------------
🚨 **これが無いと「< 0.2px 達成」を測っているつもりで、測れないものを測ることになる。**

最初の GNBP-XA-2 の背景は斜めの帯 2 本だけだった。帯は**帯の向きへ平行移動しても
像が変わらない**ので、その向きの体動は画像から**原理的に回収できない**（アパーチャ問題）。
実測では帯に沿って 6px 動かしても残差が 6%（＝ノイズと同程度）しか動かず、推定器が
何を返しても真値と 0.58px ずれていた。**推定器の欠陥ではなくファントムの欠陥**で、
§16.4 の箱型断面・§16.3 の回転楕円体と同じ「仮定に都合のよいファントム」の罠。

そこで背景に向きの違う構造を重ねた（斜めの帯＋縦の脊椎＋椎体の切れ目＋点状の塊）。
ここでは**その性質を毎回測る**: 真値のシフトが残差の最小点になっていること、そして
**どの向きへ動かしても残差が上がること**（縮退した向きが無いこと）。

⚠️ わざとアプリ（TypeScript）の実装を使わずに Python で書き直してある。アプリの
コードで確かめると「アプリが自分の都合で最小になる点」を見ているだけになりかねない。
ここで確かめたいのは**画像が体動の情報を持っていること**であって、推定器の出来ではない。

使い方:
    python3 check_xa2_motion.py --phantom ./phantom/GNBP-XA
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pydicom

#: 残差を評価する画素の間引き（アプリと同じ 512²→128²）。
STRIDE = 4
#: 血管（＝差分で大きく出る側）を落とすため、絶対値の上位をこれだけ除外する。
EXCLUDE_TOP = 0.10
#: log を取るときのゼロ除け（アプリと同じ）。
LOG_EPS = 1e-3
#: 真値まわりで残差の最小点を探す窓 [px] と刻み。
WIN, STEP = 1.0, 0.1
#: 最小点が真値からこれ以上離れていたら、そのフレームは「体動を取り戻せない」。
TOL_PX = 0.2
#: 0.5px 動かしたときに残差が上がるべき割合（どの向きでも）。縮退した向きの検出。
MIN_RISE = 0.02
#: 残差を測る前に両方へ掛けるガウシアンの σ [px]。
#:
#: 🚨 **これを 0 にすると、ファントムの良し悪しではなく補間の都合を測ることになる。**
#: 双線形補間は隣接画素を混ぜる＝ノイズを平滑化するので、**端数のシフトほど残差が下がる**。
#: 整数の体動では真値そのものが平滑化されないため、ずれた端数の位置のほうが残差が小さくなり、
#: 「真値が最小点」がどんなファントムでも成り立たなくなる（実測 0.36px ずれ）。
#: ここで見たいのは**画像が体動の情報を持っているか**なので、その交絡を先に潰しておく。
#: 推定器がこの偏りに引っかからないことは `dsa.test.ts` が別に固定している。
SEARCH_BLUR_SIGMA = 0.8

passed = 0
failures = 0


def check(cond: bool, label: str, detail: str = "") -> None:
    global passed, failures
    if cond:
        passed += 1
        print(f"  [ok  ] {label}{'  ' + detail if detail else ''}")
    else:
        failures += 1
        print(f"  [FAIL] {label}{'  ' + detail if detail else ''}")


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """分離型ガウシアン（端は複製）。scipy に依存しないよう自前で書く。"""
    if sigma <= 0:
        return img
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(img, r, mode="edge")
    out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 0, pad)
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 1, out)


def shift_bilinear(src: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """(dx, dy) だけずらす（範囲外は端の複製）。アプリの `shiftBilinear` と同じ規約。"""
    h, w = src.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    sx = np.clip(xx - dx, 0, w - 1)
    sy = np.clip(yy - dy, 0, h - 1)
    x0 = np.floor(sx).astype(int)
    y0 = np.floor(sy).astype(int)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = sx - x0
    fy = sy - y0
    top = src[y0, x0] * (1 - fx) + src[y0, x1] * fx
    bottom = src[y1, x0] * (1 - fx) + src[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def residual(mask: np.ndarray, live: np.ndarray, dx: float, dy: float) -> float:
    """ずらしたマスクとの差分の、上位を除いた RMS（小さいほど合っている）。"""
    m = shift_bilinear(mask, dx, dy)[::STRIDE, ::STRIDE]
    l = live[::STRIDE, ::STRIDE]
    d = np.log(np.maximum(m, 0) + LOG_EPS) - np.log(np.maximum(l, 0) + LOG_EPS)
    a = np.abs(d).ravel()
    cut = np.sort(a)[int(np.ceil(a.size * (1 - EXCLUDE_TOP))) - 1]
    keep = d.ravel()[a <= cut]
    return float(np.sqrt((keep ** 2).mean()))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phantom", default="./phantom/GNBP-XA")
    args = ap.parse_args()

    truth = json.load(open(os.path.join(args.phantom, "truth.json"), encoding="utf-8"))["dsa"]
    ds = pydicom.dcmread(os.path.join(args.phantom, truth["file"]))
    px = ds.pixel_array.astype(np.float64)
    mask_idx = [f - 1 for f in truth["maskFrames"]]
    mask = blur(px[mask_idx].mean(axis=0), SEARCH_BLUR_SIGMA)

    # 注入した体動の種類ごとに 1 フレームずつ見る（同じ値のフレームを 20 回測っても情報は増えない）。
    seen: dict[tuple[float, float], int] = {}
    for f in truth["shifts"]:
        if f["frame"] <= len(mask_idx):
            continue
        seen.setdefault((f["dxPx"], f["dyPx"]), f["frame"])

    print(f"マスク: フレーム {truth['maskFrames']}  造影到達: {truth['contrastArrivalFrame']}")
    print(f"注入した体動: {len(seen)} 種類\n")

    for (tx, ty), frame_no in sorted(seen.items(), key=lambda kv: kv[1]):
        live = blur(px[frame_no - 1], SEARCH_BLUR_SIGMA)
        r_true = residual(mask, live, tx, ty)

        # ① 真値のまわりで最小点を探す。真値からずれていたら、その体動は画像から回収できない。
        best = (r_true, tx, ty)
        n = int(round(WIN / STEP))
        for iy in range(-n, n + 1):
            for ix in range(-n, n + 1):
                dx, dy = tx + ix * STEP, ty + iy * STEP
                r = residual(mask, live, dx, dy)
                if r < best[0]:
                    best = (r, dx, dy)
        err = float(np.hypot(best[1] - tx, best[2] - ty))
        check(
            err <= TOL_PX,
            f"f{frame_no:2d} 真値 ({tx:+.1f}, {ty:+.1f}) が残差の最小点",
            f"最小=({best[1]:+.2f}, {best[2]:+.2f}) ずれ {err:.2f}px  R={r_true:.6f}",
        )

        # ② どの向きへ 0.5px 動かしても残差が上がるか（＝縮退した向きが無いか）。
        #    🚨 ここが本体。旧版の背景は帯の向きだけ「動かしても上がらない」ので落ちる。
        rises = []
        for deg in range(0, 180, 10):
            u = np.array([np.cos(np.radians(deg)), np.sin(np.radians(deg))])
            rise = min(
                residual(mask, live, tx + 0.5 * u[0], ty + 0.5 * u[1]),
                residual(mask, live, tx - 0.5 * u[0], ty - 0.5 * u[1]),
            ) - r_true
            rises.append((rise / r_true, deg))
        worst, worst_deg = min(rises)
        check(
            worst >= MIN_RISE,
            f"f{frame_no:2d} どの向きへ 0.5px ずらしても残差が上がる（縮退した向きが無い）",
            f"最悪 {worst * 100:+.1f}% ({worst_deg}°) / 最良 {max(rises)[0] * 100:+.1f}% ({max(rises)[1]}°)",
        )

    # ③ 端数の体動が入っていること。整数だけだと推定器の「詰め」の段が試されないまま通る。
    fractional = [k for k in seen if k[0] != round(k[0]) or k[1] != round(k[1])]
    check(bool(fractional), "端数の体動が注入されている（詰めの段を踏ませる）", f"{fractional}")
    # ④ 探索半径より大きい体動が入っていること（半径そのものを試す）。
    big = [k for k in seen if max(abs(k[0]), abs(k[1])) > 4.0]
    check(bool(big), "4px を超える体動が注入されている（探索半径を試す）", f"{big}")

    print(f"\n===== GNBP-XA-2 体動チェック =====")
    print(f"合格 {passed} / 失敗 {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
