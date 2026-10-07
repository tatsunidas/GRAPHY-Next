"""
保管・書き出しされた DICOM シリーズ（1 フレーム 1 ファイル）を、実際の値の NIfTI にする（照合用・compare-nifti.py に渡す）。

    python dicom-series-to-nifti.py <DICOM のフォルダ（下位も探す）> <出力.nii.gz>

- 通常の画像: 値 = 保存値 × RescaleSlope + RescaleIntercept（PixelRepresentation に従って符号を読む）。PixelPaddingValue の画素は NaN
- Parametric Map（NIfTI の float の取り込み・fw/nifti-import.md §3.1）: Float Pixel Data を RWVM の傾き・切片で戻す。NaN はそのまま。
  幾何は Functional Groups（共有の PlaneOrientation・PixelMeasures、フレームごとの PlanePosition）から取る
- 幾何は IPP・IOP・PixelSpacing から LPS のアフィンを作り、RAS に直して書く。並びは IPP の法線方向の位置で並べ直す
- 値は float64 で書く（照合で丸めを足さないため）。DICOMDIR などの画像でないファイルは飛ばす
"""
import glob
import os
import sys

import nibabel as nib
import numpy as np
import pydicom

PARAMETRIC_MAP = "1.2.840.10008.5.1.4.1.1.30"

src, out = sys.argv[1], sys.argv[2]
dss = []
for p in sorted(glob.glob(os.path.join(src, "**", "*"), recursive=True)):
    if not os.path.isfile(p):
        continue
    try:
        d = pydicom.dcmread(p)
    except Exception:
        continue
    if "SOPClassUID" in d and ("PixelData" in d or "FloatPixelData" in d):
        dss.append(d)


def is_pm(d):
    return str(d.SOPClassUID) == PARAMETRIC_MAP


def iop_of(d):
    if is_pm(d):
        return np.array(d.SharedFunctionalGroupsSequence[0].PlaneOrientationSequence[0].ImageOrientationPatient, float)
    return np.array(d.ImageOrientationPatient, float)


def ipp_of(d):
    if is_pm(d):
        return np.array(d.PerFrameFunctionalGroupsSequence[0].PlanePositionSequence[0].ImagePositionPatient, float)
    return np.array(d.ImagePositionPatient, float)


def spacing_of(d):
    if is_pm(d):
        return d.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing
    return d.PixelSpacing


def values_of(d):
    if is_pm(d):
        a = d.pixel_array.astype(np.float64)       # Float Pixel Data（NaN はそのまま）
        m = d.SharedFunctionalGroupsSequence[0].get("RealWorldValueMappingSequence")
        if m:
            a = a * float(m[0].get("RealWorldValueSlope", 1)) + float(m[0].get("RealWorldValueIntercept", 0))
        return a
    a = d.pixel_array.astype(np.float64)            # pydicom は PixelRepresentation に従って符号を読む
    slope = float(getattr(d, "RescaleSlope", 1) or 1)
    inter = float(getattr(d, "RescaleIntercept", 0) or 0)
    v = a * slope + inter
    pad = getattr(d, "PixelPaddingValue", None)
    if pad is not None:
        v[d.pixel_array == pad] = np.nan
    return v


iop = iop_of(dss[0])
row, col = iop[:3], iop[3:]
normal = np.cross(row, col)
dss.sort(key=lambda d: float(np.dot(ipp_of(d), normal)))
rows, cols = int(dss[0].Rows), int(dss[0].Columns)
vol = np.zeros((cols, rows, len(dss)), np.float64)   # [i(列), j(行), k]
for k, d in enumerate(dss):
    vol[:, :, k] = values_of(d).T
ps = spacing_of(dss[0])
dr, dc = float(ps[0]), float(ps[1])
p0 = ipp_of(dss[0])
p1 = ipp_of(dss[-1])
step = (p1 - p0) / max(1, len(dss) - 1)
lps = np.eye(4)
lps[:3, 0] = row * dc      # 列が 1 進む
lps[:3, 1] = col * dr      # 行が 1 進む
lps[:3, 2] = step
lps[:3, 3] = p0
ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ lps
nib.save(nib.Nifti1Image(vol, ras), out)
print("wrote", out, vol.shape, "parametric-map" if is_pm(dss[0]) else "image")
