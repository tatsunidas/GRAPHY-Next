#!/usr/bin/env python3
"""向き・位置（検証項目 c）の検査: ラベルの重心が、体の重心に対して期待どおりの側にあるか。

NIfTI の取り込みで画像と基準ラベルが同じ向きに間違うと Dice には出ない（共通モードの誤り）。
そこで DICOM シリーズ（取り込み経路が違う）に Bundle を走らせ、体の重心を DICOM から独立に求めて、
SEG の重心の側（患者座標 LPS: x 大 = 患者の左、y 大 = 後方、z 大 = 頭側）を見る。
閾値は置かない。符号（側）だけを見て、重心のずれ（mm）を併せて返す。
"""
from __future__ import annotations

import glob
import os

import numpy as np

SIDE = {"x": ("右", "左"), "y": ("前", "後"), "z": ("足", "頭")}


def body_centroid_lps(dicom_dir: str, air_hu: float = -300.0) -> np.ndarray:
    """CT シリーズから体の重心（LPS・mm）。空気 -300 HU 以下を除き、断面ごとに最大連結成分の穴を埋める。"""
    import pydicom
    from scipy import ndimage

    files = sorted(glob.glob(os.path.join(dicom_dir, "*.dcm")))
    if not files:
        raise ValueError(f"DICOM がありません: {dicom_dir}")
    dss = [pydicom.dcmread(f) for f in files]
    iop = np.array(dss[0].ImageOrientationPatient, float)
    normal = np.cross(iop[:3], iop[3:])
    dss.sort(key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, float), normal)))
    sums, count = np.zeros(3), 0
    for d in dss:
        hu = d.pixel_array.astype(float) * float(getattr(d, "RescaleSlope", 1)) + float(getattr(d, "RescaleIntercept", 0))
        lab, n = ndimage.label(hu > air_hu)
        if n == 0:
            continue
        big = lab == (1 + int(np.argmax(ndimage.sum(np.ones_like(lab), lab, range(1, n + 1)))))
        mask = ndimage.binary_fill_holes(big)
        r, c = np.nonzero(mask)
        ps = [float(x) for x in d.PixelSpacing]  # [行間隔, 列間隔]
        ipp = np.array(d.ImagePositionPatient, float)
        pts = ipp[None, :] + np.outer(c * ps[1], iop[:3]) + np.outer(r * ps[0], iop[3:])
        sums += pts.sum(0)
        count += len(r)
    if count == 0:
        raise ValueError("体の領域が取れません")
    return sums / count


def label_centroid_lps(vol, value: int) -> np.ndarray:
    idx = np.argwhere(vol.data == value)
    if len(idx) == 0:
        raise ValueError(f"ラベル {value} のボクセルがありません")
    p = (vol.affine @ np.c_[idx, np.ones(len(idx))].T).T[:, :3]
    return p.mean(0)


def check_side(label_c: np.ndarray, body_c: np.ndarray, expect: dict) -> dict:
    """expect: {"x": +1 or -1, ...}（+1 = LPS でその軸の大きい側）。軸ごとに、ずれ(mm)と期待の側かを返す。"""
    out = {}
    for ax, sign in expect.items():
        d = float(label_c["xyz".index(ax)] - body_c["xyz".index(ax)])
        out[ax] = {"offset_mm": round(d, 2), "expected_side": SIDE[ax][sign > 0], "ok": bool(d * sign > 0)}
    out["all_ok"] = all(v["ok"] for v in out.values())
    return out


def main(argv=None) -> int:
    import argparse
    import json
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I はスクリプトのフォルダを探さない
    import monai_score as m

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seg", required=True)
    ap.add_argument("--dicom-dir", required=True, help="Bundle に渡した CT の DICOM シリーズのフォルダ")
    ap.add_argument("--label-value", type=int, required=True)
    ap.add_argument("--expect", required=True, help='例: "x=+1,y=+1"（LPS の大きい側が +1）')
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    expect = {kv.split("=")[0]: int(kv.split("=")[1]) for kv in a.expect.split(",")}
    res = check_side(label_centroid_lps(m.read_seg(a.seg), a.label_value), body_centroid_lps(a.dicom_dir), expect)
    with open(a.out, "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    return 0 if res["all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
