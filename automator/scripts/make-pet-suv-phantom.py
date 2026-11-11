"""
%ID/cc 校正（体重なしの PET）の実機検査に使う合成 PET を作る。

    python make-pet-suv-phantom.py <出力フォルダ>

BQML の PT 1 シリーズ（64×64 画素、4 mm 格子、21 枚、z = −40 … +40 mm、間隔 4 mm）。
体重・身長は書かない（小動物 PET の想定）。投与量・半減期・投与時刻・撮像時刻は
RadiopharmaceuticalInformationSequence と AcquisitionTime に書く。
一様な球 2 個（目的 C_T・参照 C_R。中心 x = ±40 mm、半径 20 mm）を一様背景 C_B の中に置く。
truth.json には濃度・投与量・時刻だけを書く（期待値は検査側で別の式から出す）。
RescaleSlope は 1 でない値にして、乗数の二重掛けを見逃さない。
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, PositronEmissionTomographyImageStorage, generate_uid

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

N, MM = 64, 4.0
Z = [-40.0 + 4.0 * k for k in range(21)]
C_TARGET, C_REF, C_BG = 2000.0, 500.0, 100.0  # Bq/mL
CENTER_T = (40.0, 0.0, 0.0)
CENTER_R = (-40.0, 0.0, 0.0)
RADIUS = 20.0
DOSE_BQ = 5.0e6  # 5 MBq（小動物）
HALF_LIFE_S = 6586.2
INJ, SCAN = "090000", "100000"  # 投与 1 時間後
SLOPE = 2.0

study, series, frame = generate_uid(), generate_uid(), generate_uid()
origin = -(N - 1) * MM / 2.0
xs = origin + MM * np.arange(N)
X, Y = np.meshgrid(xs, xs)

for k, z in enumerate(Z):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = PositronEmissionTomographyImageStorage
    sop = generate_uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = PositronEmissionTomographyImageStorage, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
    ds.PatientID, ds.PatientName = "PID-PHANTOM", "Pid^Phantom"
    ds.StudyDate, ds.StudyTime = "20260101", "090000"
    ds.SeriesDate = ds.AcquisitionDate = "20260101"
    ds.AcquisitionTime, ds.SeriesTime = SCAN, SCAN
    ds.StudyDescription, ds.SeriesDescription = "pid phantom", "PET small animal"
    ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "PT", 1, k + 1
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [origin, origin, float(z)]
    ds.PixelSpacing, ds.SliceThickness = [MM, MM], MM
    ds.Rows = ds.Columns = N
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 0
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = SLOPE, 0.0, "BQML"
    ds.Units, ds.DecayCorrection, ds.CorrectedImage = "BQML", "START", ["ATTN", "DECY"]
    rp = Dataset()
    rp.Radiopharmaceutical = "Fluorodeoxyglucose"
    rp.RadionuclideTotalDose = DOSE_BQ
    rp.RadionuclideHalfLife = HALF_LIFE_S
    rp.RadiopharmaceuticalStartTime = INJ
    code = Dataset()
    code.CodeValue, code.CodingSchemeDesignator, code.CodeMeaning = "C-111A1", "SRT", "^18^Fluorine"
    rp.RadionuclideCodeSequence = Sequence([code])
    ds.RadiopharmaceuticalInformationSequence = Sequence([rp])
    f = np.full((N, N), C_BG)
    for (cx, cy, cz), c in ((CENTER_T, C_TARGET), (CENTER_R, C_REF)):
        f[(X - cx) ** 2 + (Y - cy) ** 2 + (z - cz) ** 2 <= RADIUS ** 2] = c
    ds.PixelData = np.rint(f / SLOPE).astype(np.uint16).tobytes()
    ds.save_as(os.path.join(out, f"pt_{k:02d}.dcm"), write_like_original=False)

with open(os.path.join(out, "truth.json"), "w", encoding="utf-8") as fh:
    json.dump({
        "c_target": C_TARGET, "c_ref": C_REF, "c_bg": C_BG, "dose_bq": DOSE_BQ,
        "half_life_s": HALF_LIFE_S, "injection_time": INJ, "scan_time": SCAN,
        "slope": SLOPE, "radius_mm": RADIUS, "center_target_lps": CENTER_T, "center_ref_lps": CENTER_R,
        "grid": {"n": N, "mm": MM, "origin_xy": origin, "z": Z},
        "pt_series_uid": str(series),
    }, fh, indent=2)
print("ok")
