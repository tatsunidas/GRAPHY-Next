"""geom2dCheck.ts 用の合成 CT（向き・欠損・チルトを変えられる）。患者情報は合成の値だけ。

使い方: python3 -I geom2dSynth.py <出力ディレクトリ> <乱数の種> <モード>
モード:
  axial      軸位（IOP (1,0,0,0,1,0)、IPP (0,0,2k)）
  feetfirst  足向きの軸位（IOP (1,0,0,0,-1,0)、IPP z が降順）
  sagittal   矢状（IOP (0,1,0,0,0,-1)、IPP x = -10 - 2k）
  coronal    冠状（IOP (1,0,0,0,0,-1)、IPP y = 5 + 2k）
  missing    軸位でスライス 7 が欠損
  tilt       ガントリーチルトに相当（スライスごとに IPP の y がずれる。IOP は軸位）
標準出力: JSON（SEG に要る幾何、各スライスの IPP、ROI の箱、期待する位置の昇順の並び）。
ROI: 面内の箱（行 12..36、列 10..34）を、スライス番号 3..12 に置く（10 枚）。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

out, seed, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(out, exist_ok=True)
W = H = 48
N = 16
SP = [0.7, 0.7]
THICK = 2.0
rng = np.random.default_rng(seed)
study, series, forr = (generate_uid() for _ in range(3))

IOP = {
    "axial": [1, 0, 0, 0, 1, 0], "missing": [1, 0, 0, 0, 1, 0], "tilt": [1, 0, 0, 0, 1, 0],
    "feetfirst": [1, 0, 0, 0, -1, 0], "sagittal": [0, 1, 0, 0, 0, -1], "coronal": [1, 0, 0, 0, 0, -1],
}[mode]


def ipp_of(k):
    if mode == "feetfirst":
        return [0.0, 0.0, 100.0 - THICK * k]
    if mode == "sagittal":
        return [-10.0 - THICK * k, 0.0, 0.0]
    if mode == "coronal":
        return [0.0, 5.0 + THICK * k, 0.0]
    if mode == "tilt":
        return [0.0, THICK * k * math.tan(math.radians(10)), THICK * k]
    return [0.0, 0.0, THICK * k]


# 元のスライス番号（欠損は 7 を飛ばす）
ks = [k for k in range(N) if not (mode == "missing" and k == 7)]
vol = rng.integers(0, 300, (N, H, W)).astype(np.uint16)
frames = []
for k in ks:
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = CTImageStorage
    sop = generate_uid()
    fm.MediaStorageSOPInstanceUID = sop
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    d = Dataset()
    d.file_meta = fm
    d.SOPClassUID = CTImageStorage
    d.SOPInstanceUID = sop
    d.PatientName = "SYNTH^GEOM2D"
    d.PatientID = f"SYNTHGEOM-{mode}"
    d.PatientBirthDate = "19010203"
    d.PatientSex = "O"
    d.StudyInstanceUID = study
    d.SeriesInstanceUID = series
    d.Modality = "CT"
    d.SeriesNumber = 1
    d.InstanceNumber = k + 1
    d.SeriesDescription = f"synthetic geom2d {mode}"
    d.FrameOfReferenceUID = forr
    d.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    d.RescaleType = "HU"
    d.ImageOrientationPatient = IOP
    ipp = ipp_of(k)
    d.ImagePositionPatient = ipp
    d.PixelSpacing = SP
    d.SliceThickness = THICK
    d.Rows = H
    d.Columns = W
    d.BitsAllocated = 16
    d.BitsStored = 16
    d.HighBit = 15
    d.SamplesPerPixel = 1
    d.PhotometricInterpretation = "MONOCHROME2"
    d.PixelRepresentation = 0
    d.RescaleSlope = 1
    d.RescaleIntercept = -1000
    d.PixelData = vol[k].tobytes()
    d.StudyDate = "20260101"
    d.save_as(os.path.join(out, f"g_{k:03d}.dcm"), enforce_file_format=True)
    frames.append({"k": k, "sopInstanceUid": sop, "imagePositionPatient": ipp})

# 独立の基準（planes2dRef.py）用に、校正後（HU）の体積を残す。取り込むディレクトリの外へ置く
np.save(os.path.join(os.path.dirname(os.path.abspath(out)), f"{mode}_vol.npy"), vol.astype(np.float64) - 1000.0)
BOX = {"r0": 12, "r1": 36, "c0": 10, "c1": 34, "k0": 3, "k1": 13}
plane_axis = {"axial": 2, "missing": 2, "tilt": 2, "feetfirst": 2, "sagittal": 0, "coronal": 1}[mode]
# 期待する位置: 箱のスライスの、患者軸の座標（チルトは z）。昇順。
# 欠損のシリーズは、取り直した格子（欠損の位置にも補間したスライスが 1 枚入る）の位置になる（旗 RECTIFIED_GRID）ので、欠損のスライスも数える
expected = sorted(ipp_of(k)[plane_axis] for k in range(N) if BOX["k0"] <= k < BOX["k1"] and (mode == "missing" or k in ks))
print(json.dumps({
    "mode": mode, "studyInstanceUid": study, "seriesInstanceUid": series, "frameOfReferenceUID": forr,
    "rows": H, "columns": W, "pixelSpacing": SP, "sliceThickness": THICK, "iop": IOP, "frames": frames, "box": BOX,
    "expectedPositionsMm": expected,
    "expectedPlane": {"axial": "AXIAL", "missing": "AXIAL", "tilt": "AXIAL", "feetfirst": "AXIAL", "sagittal": "SAGITTAL", "coronal": "CORONAL"}[mode],
    "boxPixels": (BOX["r1"] - BOX["r0"]) * (BOX["c1"] - BOX["c0"]),
}))
