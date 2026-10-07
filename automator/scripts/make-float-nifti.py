"""
整数でない float32 の NIfTI（ADC のような小さい値と NaN）を作る。Parametric Map での取り込みの実機確認用（fw/nifti-import.md §3.1）。

    python make-float-nifti.py <出力.nii.gz> <答え.json>

答えの JSON には、いくつかのボクセルの患者座標（LPS・mm）と、そこにあるべき float32 の値（NaN は null）を書く。
測る側（本体の H10）とは独立に、NIfTI のアフィンから座標を出す。
"""
import json
import sys

import nibabel as nib
import numpy as np

out, truth = sys.argv[1], sys.argv[2]
nx, ny, nz = 48, 40, 12
x, y, z = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij")
vol = (0.0007 + 0.0011 * np.sin(x / 7.0) * np.cos(y / 5.0) + 0.00003 * z).astype(np.float32)
vol[10:14, 8:12, 3:5] = np.nan          # マスクの外のような NaN の塊
affine = np.array([[0.9, 0, 0, -20.0], [0, 1.1, 0, 15.0], [0, 0, 3.0, 40.0], [0, 0, 0, 1]])   # RAS
img = nib.Nifti1Image(vol, affine)
img.set_sform(affine, 1)
img.set_qform(affine, 1)
img.header.set_xyzt_units("mm")
nib.save(img, out)

samples = []
for (i, j, k) in [(0, 0, 0), (5, 7, 2), (11, 9, 3), (30, 20, 6), (47, 39, 11), (12, 10, 4)]:
    ras = affine @ [i, j, k, 1]
    v = float(vol[i, j, k])
    samples.append({"index": [i, j, k], "lps": [-ras[0], -ras[1], ras[2]], "value": None if np.isnan(v) else v})
# ROI 統計の答え: NaN の塊にかかる箱（インデックス i 8..15・j 6..13・k 3..4）を、ボクセルの端まで含めた
# 患者座標の範囲で渡す。測る側はボクセル中心がこの範囲に入るものを数える。NaN は数えない。
lo, hi = np.array([8, 6, 3]) - 0.5, np.array([15, 13, 4]) + 0.5
corners = np.array([affine @ [a, b, c, 1] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])])[:, :3]
corners[:, :2] *= -1   # RAS → LPS
box = vol[8:16, 6:14, 3:5]
roi = {"lpsMin": corners.min(0).tolist(), "lpsMax": corners.max(0).tolist(),
       "voxels": int(box.size), "n": int(np.isfinite(box).sum()), "mean": float(np.nanmean(box.astype(np.float64)))}
json.dump({"dims": [nx, ny, nz], "nanVoxels": int(np.isnan(vol).sum()), "samples": samples, "roi": roi,
           "nanPerSlice": [int(np.isnan(vol[:, :, k]).sum()) for k in range(nz)],
           "finiteMin": float(np.nanmin(vol)), "finiteMax": float(np.nanmax(vol))}, open(truth, "w"), indent=1)
print(json.dumps(samples))
