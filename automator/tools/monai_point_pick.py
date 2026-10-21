"""基準ラベルから、陽性の点（ラベルの中）と陰性の点（ラベルから遠い体の中）を患者座標（LPS, mm）で選ぶ。

プラグインの「点」の入力欄（x, y, z, positive|negative）にそのまま貼れる形で出す。
使い方: python -I monai_point_pick.py --image <ct.nii.gz> --label <label.nii.gz> --value 1 [--min-dist-mm 40] [--out points.txt]
陽性 = ラベルの重心に最も近いラベル内のボクセル（重心が外にあっても内側の点を返す）。
陰性 = ラベルから min-dist-mm 以上離れた、体の中（HU > -300）のボクセルのうち、陽性から最も遠くないもの（再現のため距離が最小のもの）。
"""
import argparse

import nibabel as nib
import numpy as np
from scipy import ndimage


def to_lps(affine: np.ndarray, ijk) -> list:
    """NIfTI（RAS）の添字 → 患者座標（LPS）。"""
    ras = affine @ np.array([ijk[0], ijk[1], ijk[2], 1.0])
    return [-float(ras[0]), -float(ras[1]), float(ras[2])]


def pick(image: np.ndarray, label: np.ndarray, value: int, spacing, min_dist_mm: float = 40.0):
    inside = label == value
    if not inside.any():
        raise ValueError("ラベル %d のボクセルがありません" % value)
    com = np.array(ndimage.center_of_mass(inside))
    idx = np.argwhere(inside)
    pos = idx[int(np.argmin(((idx - com) ** 2).sum(axis=1)))]
    dist = ndimage.distance_transform_edt(~(label > 0), sampling=spacing)
    body = image > -300
    cand = np.argwhere(body & (dist >= min_dist_mm))
    if len(cand) == 0:
        raise ValueError("ラベルから %.0f mm 以上離れた体の中のボクセルがありません" % min_dist_mm)
    d = dist[tuple(cand.T)]
    neg = cand[int(np.argmin(d))]
    return tuple(int(v) for v in pos), tuple(int(v) for v in neg)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--value", type=int, default=1)
    ap.add_argument("--min-dist-mm", type=float, default=40.0)
    ap.add_argument("--out")
    a = ap.parse_args()
    img, lab = nib.load(a.image), nib.load(a.label)
    if img.shape != lab.shape or not np.allclose(img.affine, lab.affine, atol=1e-3):
        raise SystemExit("画像とラベルの格子が違います")
    pos, neg = pick(np.asanyarray(img.dataobj), np.asanyarray(lab.dataobj).astype(np.int32), a.value, img.header.get_zooms()[:3], a.min_dist_mm)
    lines = ["%.3f, %.3f, %.3f, positive" % tuple(to_lps(img.affine, pos)), "%.3f, %.3f, %.3f, negative" % tuple(to_lps(img.affine, neg))]
    text = "\n".join(lines) + "\n"
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
    print(text, end="")


if __name__ == "__main__":
    main()
