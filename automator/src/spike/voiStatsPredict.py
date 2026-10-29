"""VOI 統計の一括スパイク用: 合成 CT の箱の中の統計量（予測値）を、書き出した DICOM から求める。

使い方: voiStatsPredict.py <CT のディレクトリ> <箱の JSON: {"名前": [r0,r1,c0,c1,z0,z1]}>
スライスは ct_000.dcm… の順（z）。値は RescaleSlope/Intercept を当てた強度。SD は母集団（ddof=0）。
"""
import glob
import json
import sys

import numpy as np
import pydicom

d, boxes = sys.argv[1], json.loads(sys.argv[2])
files = sorted(glob.glob(f"{d}/ct_*.dcm"))
vol = np.stack([
    ds.pixel_array.astype(np.float64) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    for ds in (pydicom.dcmread(f) for f in files)
])
out = {}
for name, (r0, r1, c0, c1, z0, z1) in boxes.items():
    v = vol[z0:z1, r0:r1, c0:c1].ravel()
    out[name] = {
        "n": int(v.size), "mean": float(v.mean()), "sd": float(v.std(ddof=0)),
        "min": float(v.min()), "max": float(v.max()), "median": float(np.median(v)),
    }
print(json.dumps(out))
