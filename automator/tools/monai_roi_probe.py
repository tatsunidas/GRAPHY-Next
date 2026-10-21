"""プラグインが出した点（患者座標 LPS, mm）の位置の画素値を、NIfTI から独立に読む。

使い方: python -I monai_roi_probe.py --image <nii.gz> --points "<x, y, z, role の行>" [--flip-z | --swap-xy]
出力: 行ごとの画素値（最近傍の 1 画素）を JSON 配列で。範囲外は null。
--flip-z / --swap-xy は負例（向きを取り違えた換算）。
"""
import argparse
import json

import nibabel as nib
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--points", required=True)
    ap.add_argument("--flip-z", action="store_true")
    ap.add_argument("--swap-xy", action="store_true")
    a = ap.parse_args()
    img = nib.load(a.image)
    data = np.asanyarray(img.dataobj)
    inv = np.linalg.inv(img.affine)
    out = []
    for line in a.points.strip().splitlines():
        x, y, z = (float(s) for s in line.split(",")[:3])
        if a.swap_xy:
            x, y = y, x
        ras = np.array([-x, -y, z, 1.0])  # LPS → RAS
        i, j, k = np.rint((inv @ ras)[:3]).astype(int)
        if a.flip_z:
            k = data.shape[2] - 1 - k
        ok = 0 <= i < data.shape[0] and 0 <= j < data.shape[1] and 0 <= k < data.shape[2]
        out.append(float(data[i, j, k]) if ok else None)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
