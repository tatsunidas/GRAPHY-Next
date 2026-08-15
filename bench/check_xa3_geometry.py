#!/usr/bin/env python3
# GRAPHY-Next Benchmark (GNBP-XA-3 geometry check)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
"""GNBP-XA-3 の「真値の 3D 点が本当に血管の上に落ちるか」を画素で確かめる。

`fw/angio-design.md` §10.1 / A6a。

なぜ要るのか
------------
投影の式は `xaGeometry.test.ts` で TypeScript と Python の一致を確かめてある。
しかしそれは**式どうしの一致**であって、「生成された **画像** が本当にその式どおりの
場所に血管を描いているか」は別問題。描画側（`_project_tree`）が独自にずれていても
式の突き合わせでは分からない。ここでは **DICOM の画素そのもの**を読んで、
真値の中心線を投影した位置が暗い（＝血管がある）ことを確かめる。

⚠️ これも「角度定義が DICOM 規格として正しいこと」は確かめられない（§10.1 の注意）。

使い方:
    python3 check_xa3_geometry.py --phantom ./phantom/GNBP-XA
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import pydicom

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_phantom_xa import _project_points  # noqa: E402

#: 中心線上の点は「血管の中」なので、背景よりはっきり暗いはず。
#: 背景 4095 に対し、最も細い遠位（径 2.0mm）でも 20% 以上は落ちる。
DARK_FRACTION = 0.90
#: 中心線の点のうち、この割合以上が暗ければ合格（端点は画像外に出うる）。
MIN_HIT_RATE = 0.95


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--phantom", default="./phantom/GNBP-XA")
    args = ap.parse_args()

    truth_path = os.path.join(args.phantom, "truth.json")
    with open(truth_path, encoding="utf-8") as f:
        truth = json.load(f)
    if "recon3d" not in truth:
        print("truth.json に recon3d がありません（--series recon3d で生成してください）", file=sys.stderr)
        return 2
    section = truth["recon3d"]

    failures = 0
    passed = 0

    def check(ok: bool, label: str, detail: str = "") -> None:
        nonlocal failures, passed
        if ok:
            passed += 1
            print(f"  [ok  ] {label} {detail}")
        else:
            failures += 1
            print(f"  [FAIL] {label} {detail}")

    for br in section["branches"]:
        points = np.array(br["pointsLps"], dtype=float)
        for view in section["views"]:
            true_angles = (view["truePrimaryAngleDeg"], view["trueSecondaryAngleDeg"])
            tag_angles = (
                view["angleError"]["taggedPrimaryAngleDeg"],
                view["angleError"]["taggedSecondaryAngleDeg"],
            )
            path = os.path.join(args.phantom, view["exact"]["file"])
            img = pydicom.dcmread(path).pixel_array.squeeze().astype(float)

            # ① 真値の 3D 点を真の角度で投影すると、**画像の血管の上に落ちる**。
            col, row, _ = _project_points(points, *true_angles)
            c = np.rint(col).astype(int)
            r = np.rint(row).astype(int)
            inside = (c >= 0) & (c < img.shape[1]) & (r >= 0) & (r < img.shape[0])
            if inside.sum() == 0:
                check(False, f"{br['id']:9s} view{view['view']} 投影位置", "全点が画像外")
                continue
            values = img[r[inside], c[inside]]
            hit = float(np.mean(values < img.max() * DARK_FRACTION))
            check(
                hit >= MIN_HIT_RATE,
                f"{br['id']:9s} view{view['view']} 真の角度で中心線が血管に乗る",
                f"hit={hit:.3f}",
            )

            # ② タグの角度で投影すると**どれだけずれるか**を px で測る。
            #
            # 🚨 「角度誤差版では血管から外れること」を合否にしてはいけない。
            #    主枝は径 3.5mm（≈15px）あるので、数度のずれでも中心線は血管の内側に
            #    留まる（実際、最初にそう書いて主枝 3 本が誤って失敗した）。
            #    **外れるかどうか**ではなく、**バンドル調整が回収すべき変位量**を測る。
            col2, row2, _ = _project_points(points, *tag_angles)
            disp = np.hypot(col2 - col, row2 - row)
            mean_disp = float(np.mean(disp))
            max_disp = float(np.max(disp))
            check(
                1.5 <= mean_disp <= 60.0,
                f"{br['id']:9s} view{view['view']} 角度誤差の変位が意味のある大きさ",
                f"mean={mean_disp:.2f}px max={max_disp:.2f}px "
                f"(err {view['angleError']['primaryErrorDeg']:+.1f}/{view['angleError']['secondaryErrorDeg']:+.1f}deg)",
            )

    print(f"\n===== GNBP-XA-3 幾何チェック =====")
    print(f"合格 {passed} / 失敗 {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
