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
json.dump({"dims": [nx, ny, nz], "nanVoxels": int(np.isnan(vol).sum()), "samples": samples,
           "finiteMin": float(np.nanmin(vol)), "finiteMax": float(np.nanmax(vol))}, open(truth, "w"), indent=1)
print(json.dumps(samples))
