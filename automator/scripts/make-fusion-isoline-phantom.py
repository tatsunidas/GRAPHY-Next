"""
Fusion の等値線の真値照合に使う合成 DICOM を作る。

    python make-fusion-isoline-phantom.py <出力フォルダ>

同じ患者・同じ FrameOfReference に 2 シリーズを作る。
- 背景 CT: 128 × 128 画素、0.8 mm 格子、9 枚（z = −16 … +16 mm、間隔 4 mm）。標準の axial
- 前景 PT: 40 × 40 画素、4 mm 格子、21 枚（z = −40 … +40 mm、間隔 4 mm）。
  等方ガウス球 f(r) = A·exp(−r²/2σ²) + B を中心（0,0,0）に置く。RescaleSlope は 1 でない値。

等値線の真値は解析式で決まる: 値 L の等値面は半径 r_L = σ·√(2·ln(A/(L−B))) の球。
z = z0 の断面ではその円の半径が √(r_L² − z0²)。truth.json に A, B, σ, L, r_L, 両格子の間隔、
RescaleSlope を書く。測る側（本体の marching squares）と同じ計算はここでしない。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage, PositronEmissionTomographyImageStorage

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

A, B, SIGMA = 1000.0, 100.0, 10.0   # 前景の物理値（Bq/mL 相当）と σ [mm]
LEVEL = 400.0
R_L = SIGMA * math.sqrt(2.0 * math.log(A / (LEVEL - B)))

CT_N, CT_MM, CT_Z = 128, 0.8, [-16.0 + 4.0 * k for k in range(9)]
PT_N, PT_MM, PT_Z = 40, 4.0, [-40.0 + 4.0 * k for k in range(21)]
PT_SLOPE, PT_INTERCEPT = 0.5, 0.0

patient_id = "ISOLINE-PHANTOM"
study = generate_uid()
frame = generate_uid()
ct_series, pt_series = generate_uid(), generate_uid()


def base_ds(sop_class, modality, series_uid, number, rows, cols, mm, ipp, inst):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    sop = generate_uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop
    ds.StudyInstanceUID = study
    ds.SeriesInstanceUID = series_uid
    ds.FrameOfReferenceUID = frame
    ds.PatientID = patient_id
    ds.PatientName = "Isoline^Phantom"
    ds.StudyDate = "20260101"
    ds.StudyDescription = "isoline phantom"
    ds.Modality = modality
    ds.SeriesNumber = number
    ds.SeriesDescription = "CT background" if modality == "CT" else "PT foreground"
    ds.InstanceNumber = inst
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [float(ipp[0]), float(ipp[1]), float(ipp[2])]
    ds.PixelSpacing = [mm, mm]
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    return ds


# 背景 CT: 一様な軟部組織（HU 40）。等値線とは無関係で、背景の格子と幾何だけを与える。
ct_origin = -(CT_N - 1) * CT_MM / 2.0
for k, z in enumerate(CT_Z):
    ds = base_ds(CTImageStorage, "CT", ct_series, 1, CT_N, CT_N, CT_MM, (ct_origin, ct_origin, z), k + 1)
    ds.SliceThickness = 4.0
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = 1.0, -1024.0, "HU"
    ds.PixelData = np.full((CT_N, CT_N), 1064, np.uint16).tobytes()
    ds.save_as(os.path.join(out, f"ct_{k:02d}.dcm"), write_like_original=False)

# 前景 PT: ガウス球。保存値は uint16、物理値 = 保存値 × slope + intercept。
pt_origin = -(PT_N - 1) * PT_MM / 2.0
xs = pt_origin + PT_MM * np.arange(PT_N)
X, Y = np.meshgrid(xs, xs)
for k, z in enumerate(PT_Z):
    f = A * np.exp(-(X ** 2 + Y ** 2 + z ** 2) / (2 * SIGMA ** 2)) + B
    stored = np.rint((f - PT_INTERCEPT) / PT_SLOPE)
    assert stored.max() < 65536
    ds = base_ds(PositronEmissionTomographyImageStorage, "PT", pt_series, 2, PT_N, PT_N, PT_MM, (pt_origin, pt_origin, z), k + 1)
    ds.SliceThickness = PT_MM
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = PT_SLOPE, PT_INTERCEPT, "BQML"
    ds.Units = "BQML"
    ds.PixelData = stored.astype(np.uint16).tobytes()
    ds.save_as(os.path.join(out, f"pt_{k:02d}.dcm"), write_like_original=False)

with open(os.path.join(out, "truth.json"), "w", encoding="utf-8") as fh:
    json.dump({
        "A": A, "B": B, "sigma": SIGMA, "level": LEVEL, "r_L": R_L,
        "bg": {"cols": CT_N, "rows": CT_N, "spacing": CT_MM, "origin_xy": ct_origin, "z": CT_Z},
        "fg": {"cols": PT_N, "rows": PT_N, "spacing": PT_MM, "origin_xy": pt_origin, "z": PT_Z,
               "slope": PT_SLOPE, "intercept": PT_INTERCEPT},
        "center_lps": [0.0, 0.0, 0.0],
        "pt_series_uid": str(pt_series),
    }, fh, indent=2)
print(f"r_L = {R_L:.4f} mm")
