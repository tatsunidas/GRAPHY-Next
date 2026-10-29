"""一括抽出スパイク用: 合成 CT の箱の中で、値が下限以上の画素数を数える（予測値）。

使い方: roiFeatureRangeCount.py <CT のディレクトリ> <下限> <箱の JSON: {"名前": [r0,r1,c0,c1,z0,z1]}>
スライスは ct_000.dcm… の順（z）。値は RescaleSlope/Intercept を当てた強度。
"""
import glob
import json
import sys

import numpy as np
import pydicom

d, lo, boxes = sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3])
files = sorted(glob.glob(f"{d}/ct_*.dcm"))
vol = np.stack([
    ds.pixel_array.astype(np.float64) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    for ds in (pydicom.dcmread(f) for f in files)
])
print(json.dumps({
    name: int((vol[z0:z1, r0:r1, c0:c1] >= lo).sum())
    for name, (r0, r1, c0, c1, z0, z1) in boxes.items()
}))
