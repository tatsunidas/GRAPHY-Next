"""
値の点検（ピクセルの時間曲線）の真値照合に使う合成の動態 DICOM を作る。

    python make-dynamic-phantom.py <出力フォルダ>

時相 8 × スライス 10 の 1 シリーズ（TemporalPositionIdentifier で時相を分ける）。
値は解析的な線形場 f(P, t) = A + B·t + G·x（x は患者座標 LPS の x [mm]）。
- 32 × 32 画素、PixelSpacing は行 0.9・列 0.7 mm（異方）、IOP は標準の axial、スライス間隔 4 mm
- 保存値は uint16、RescaleSlope 0.25・RescaleIntercept −50（傾き 1 の前提で読むと値が合わない＝校正の経路も試す）
真値の式と係数は truth.json に書く。測る側（本体の時間曲線）と同じ計算はここでしない。
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

NT, NZ, ROWS, COLS = 8, 10, 32, 32
ROW_MM, COL_MM, DZ = 0.9, 0.7, 4.0        # PixelSpacing は [行の間隔, 列の間隔]
A, B, G = 100.0, 7.5, 2.0                 # f = A + B·t + G·x
SLOPE, INTERCEPT = 0.25, -50.0
ORIGIN = np.array([-COLS * COL_MM / 2.0, -ROWS * ROW_MM / 2.0, 0.0])

study, series, frame = generate_uid(), generate_uid(), generate_uid()
xs = ORIGIN[0] + COL_MM * np.arange(COLS)  # 列 i の画素中心の x [mm]（IOP が標準なので x は列だけで決まる）

for t in range(NT):
    for k in range(NZ):
        f = A + B * t + G * xs                      # 行に依らない
        stored = np.rint((f - INTERCEPT) / SLOPE)
        assert stored.min() >= 0 and stored.max() < 65536
        px = np.tile(stored, (ROWS, 1)).astype(np.uint16)
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = MRImageStorage
        sop = generate_uid()
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID = MRImageStorage
        ds.SOPInstanceUID = sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientID, ds.PatientName = "DYN-PHANTOM", "Dynamic^Phantom"
        ds.StudyDate = "20260101"
        ds.StudyDescription = "dynamic phantom"
        ds.SeriesDescription = "dynamic series"
        ds.SeriesNumber = 1
        ds.Modality = "MR"
        ds.InstanceNumber = t * NZ + k + 1
        ds.TemporalPositionIdentifier = t + 1
        ds.NumberOfTemporalPositions = NT
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [float(ORIGIN[0]), float(ORIGIN[1]), float(k * DZ)]
        ds.PixelSpacing = [ROW_MM, COL_MM]
        ds.SliceThickness = DZ
        ds.SpacingBetweenSlices = DZ
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
        ds.RescaleSlope, ds.RescaleIntercept = SLOPE, INTERCEPT
        ds.PixelData = px.tobytes()
        ds.save_as(os.path.join(out, f"t{t:02d}_z{k:02d}.dcm"), write_like_original=False)

with open(os.path.join(out, "truth.json"), "w", encoding="utf-8") as fh:
    json.dump({"A": A, "B": B, "G": G, "slope": SLOPE, "intercept": INTERCEPT, "nT": NT, "nZ": NZ,
               "spacing_col": COL_MM, "spacing_row": ROW_MM, "dz": DZ, "origin": ORIGIN.tolist()}, fh, indent=2)
print(f"{NT * NZ} files")
