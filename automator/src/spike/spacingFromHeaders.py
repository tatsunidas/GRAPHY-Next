"""mixedSpacingCheck.ts の独立の基準。合成 CT のヘッダーだけから、画素間隔（x・y）とスライス間隔（z、IPP の差）を求める。
本体（Java）の値は使わない。

使い方: python3 -I spacingFromHeaders.py <DICOM のフォルダ>
標準出力: JSON [x, y, z]（mm）
"""
import json
import os
import sys

import numpy as np
import pydicom

ds = [pydicom.dcmread(os.path.join(sys.argv[1], f), stop_before_pixels=True) for f in sorted(os.listdir(sys.argv[1])) if f.endswith(".dcm")]
iop = np.array(ds[0].ImageOrientationPatient, dtype=float)
normal = np.cross(iop[:3], iop[3:])
t = sorted(float(np.dot(np.array(d.ImagePositionPatient, dtype=float), normal)) for d in ds)
dz = float(np.median(np.diff(t)))
ps = [float(v) for v in ds[0].PixelSpacing]  # [行間隔(y), 列間隔(x)]
print(json.dumps([ps[1], ps[0], dz]))
