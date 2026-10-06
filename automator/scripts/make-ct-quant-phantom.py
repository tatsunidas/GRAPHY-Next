"""
CT 定量（fw/ct-quant-design.md §7）の真値照合に使う合成 CT（DICOM）を作る。

    python make-ct-quant-phantom.py <出力フォルダ>

CT 値が既知の直方体を空気の中に置く。真値（体積・面積・平均）は直方体の大きさと間隔から解析的に決まり、
truth.json に書く。測る側（本体の H10・H66）と同じ計算をここではしない（ボクセルを数えない）。

- 128 × 112 画素、PixelSpacing 0.8（行）× 0.7（列）mm、スライス間隔 2.5 mm、40 枚、標準の axial
- 保存値は uint16、RescaleSlope 2・RescaleIntercept −1024（傾き 1 の前提で読むと値が合わない＝校正の経路も試す）
- 直方体: fat −100 HU、muscle 50 HU、liver 60 HU、mixed（列の前半 40 HU・後半 −120 HU）
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

ROWS, COLS, NZ = 112, 128, 40
ROW_MM, COL_MM, DZ = 0.8, 0.7, 2.5        # PixelSpacing は [行の間隔, 列の間隔]
SLOPE, INTERCEPT = 2.0, -1024.0
AIR = -1000.0

# 直方体: (名前, HU, k0, k1, j0, j1, i0, i1)  範囲は半開区間 [a, b)。i は列、j は行
BOXES = [
    ("fat", -100.0, 5, 25, 10, 40, 10, 50),
    ("muscle", 50.0, 8, 20, 50, 70, 15, 45),
    ("liver", 60.0, 2, 38, 10, 60, 70, 110),
    # mixed は列の前半 [60, 80) が 40 HU、後半 [80, 100) が −120 HU
    ("mixed", None, 25, 35, 75, 100, 60, 100),
]
MIXED_SPLIT = 80

hu = np.full((NZ, ROWS, COLS), AIR, np.float64)
for name, v, k0, k1, j0, j1, i0, i1 in BOXES:
    if name == "mixed":
        hu[k0:k1, j0:j1, i0:MIXED_SPLIT] = 40.0
        hu[k0:k1, j0:j1, MIXED_SPLIT:i1] = -120.0
    else:
        hu[k0:k1, j0:j1, i0:i1] = v
stored = np.rint((hu - INTERCEPT) / SLOPE)
assert np.all(stored >= 0) and np.all(stored < 65536)
assert np.allclose(stored * SLOPE + INTERCEPT, hu), "保存値で HU が正確に表せること"
stored = stored.astype(np.uint16)

study, series, frame = generate_uid(), generate_uid(), generate_uid()
origin = np.array([-50.0, -40.0, 100.0])
for k in range(NZ):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    sop = generate_uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
    ds.PatientName, ds.PatientID = "Phantom^CtQuant", "CTQ-PHANTOM"
    ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
    ds.StudyDate = ds.SeriesDate = "20261006"
    ds.StudyTime = ds.SeriesTime = "120000"
    ds.Modality = "CT"
    ds.SeriesDescription = "CT QUANT PHANTOM"
    ds.SeriesNumber, ds.InstanceNumber = 1, k + 1
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [float(x) for x in origin + [0, 0, k * DZ]]
    ds.SliceThickness = DZ
    ds.PixelSpacing = [ROW_MM, COL_MM]
    ds.Rows, ds.Columns = ROWS, COLS
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = SLOPE, INTERCEPT, "HU"
    ds.PixelData = stored[k].tobytes()
    ds.save_as(os.path.join(out, "ct%03d.dcm" % k), enforce_file_format=True)

voxel_ml = ROW_MM * COL_MM * DZ / 1000.0
pixel_cm2 = ROW_MM * COL_MM / 100.0
truth = {"rescale": [SLOPE, INTERCEPT], "spacingMm": {"row": ROW_MM, "col": COL_MM, "slice": DZ}, "boxes": {}}
for name, v, k0, k1, j0, j1, i0, i1 in BOXES:
    # 大きさ（mm）から解析的に: 体積 = 幅 × 高さ × 奥行き
    w_mm, h_mm, d_mm = (i1 - i0) * COL_MM, (j1 - j0) * ROW_MM, (k1 - k0) * DZ
    b = {"volumeMl": w_mm * h_mm * d_mm / 1000.0, "sliceAreaCm2": w_mm * h_mm / 100.0, "k": [k0, k1]}
    if name == "mixed":
        w40, w120 = (MIXED_SPLIT - i0) * COL_MM, (i1 - MIXED_SPLIT) * COL_MM
        b["meanHu"] = (40.0 * w40 + -120.0 * w120) / (w40 + w120)
        b["values"] = [40.0, -120.0]
        b["muscleAreaCm2"] = w40 * h_mm / 100.0     # −29〜150 HU に入るのは 40 HU の側だけ
        b["fatAreaCm2"] = w120 * h_mm / 100.0       # −190〜−30 HU に入るのは −120 HU の側だけ
    else:
        b["meanHu"] = v
        b["values"] = [v]
    # 境界の 1 ボクセルを除いた内側（6 近傍）の大きさ
    b["erodedVoxels"] = max(0, (k1 - k0 - 2)) * max(0, (j1 - j0 - 2)) * max(0, (i1 - i0 - 2))
    truth["boxes"][name] = b
truth["studyUid"], truth["seriesUid"] = study, series
json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
print(json.dumps({"out": out, "series": series}))
