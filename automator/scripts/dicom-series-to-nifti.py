"""
保管された DICOM シリーズ（1 フレーム 1 ファイル）を、Rescale で戻した値の NIfTI にする（照合用・compare-nifti.py に渡す）。

    python dicom-series-to-nifti.py <DICOM のフォルダ> <出力.nii.gz>

- 値 = 保存値 × RescaleSlope + RescaleIntercept（PixelRepresentation に従って符号を読む）。PixelPaddingValue の画素は NaN
- 幾何は IPP・IOP・PixelSpacing から LPS のアフィンを作り、RAS に直して書く。並びは IPP の法線方向の位置で並べ直す
- 値は float64 で書く（照合で丸めを足さないため）
"""
import glob
import os
import sys

import nibabel as nib
import numpy as np
import pydicom

src, out = sys.argv[1], sys.argv[2]
dss = [pydicom.dcmread(p) for p in sorted(glob.glob(os.path.join(src, "*")))]
iop = np.array(dss[0].ImageOrientationPatient, float)
row, col = iop[:3], iop[3:]
normal = np.cross(row, col)
dss.sort(key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, float), normal)))
rows, cols = int(dss[0].Rows), int(dss[0].Columns)
vol = np.zeros((cols, rows, len(dss)), np.float64)   # [i(列), j(行), k]
for k, d in enumerate(dss):
    a = d.pixel_array.astype(np.float64)        # pydicom は PixelRepresentation に従って符号を読む
    slope = float(getattr(d, "RescaleSlope", 1) or 1)
    inter = float(getattr(d, "RescaleIntercept", 0) or 0)
    v = a * slope + inter
    pad = getattr(d, "PixelPaddingValue", None)
    if pad is not None:
        v[d.pixel_array == pad] = np.nan
    vol[:, :, k] = v.T
dr, dc = float(dss[0].PixelSpacing[0]), float(dss[0].PixelSpacing[1])
p0 = np.array(dss[0].ImagePositionPatient, float)
p1 = np.array(dss[-1].ImagePositionPatient, float)
step = (p1 - p0) / max(1, len(dss) - 1)
lps = np.eye(4)
lps[:3, 0] = row * dc      # 列が 1 進む
lps[:3, 1] = col * dr      # 行が 1 進む
lps[:3, 2] = step
lps[:3, 3] = p0
ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ lps
nib.save(nib.Nifti1Image(vol, ras), out)
print("wrote", out, vol.shape)
