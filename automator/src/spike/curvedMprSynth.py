"""pluginCurvedMprCheck.ts 用の合成データ: 1 患者・1 スタディ・1 シリーズ（CT、96×96×64、1 mm 等方）。

背景 -500、らせん状の管（半径 3 mm、値 800）を解析式で置く。らせんの式は truth.json に書く（検査はそれを読む）。
画素は検査用で、臨床データではない。使い方: python3 -I curvedMprSynth.py <出力ディレクトリ>
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
N, ROWS, COLS = 64, 96, 96
ORIGIN_XY = -48.0          # 0 列・0 行の中心の x, y (mm)。ボクセル (i, j) → x = ORIGIN_XY + i
R, TURNS, Z0, Z1, TUBE_R = 15.0, 1.5, 4.0, 58.0, 3.0
BG, TUBE = -500, 800


def helix(z: float) -> tuple:
    th = 2 * math.pi * TURNS * (z - Z0) / (Z1 - Z0)
    return R * math.cos(th), R * math.sin(th)


def main(out: str) -> None:
    os.makedirs(out, exist_ok=True)
    study_uid, series_uid, for_uid = generate_uid(), generate_uid(), generate_uid()
    xs = ORIGIN_XY + np.arange(COLS)[None, :]
    ys = ORIGIN_XY + np.arange(ROWS)[:, None]
    for k in range(N):
        img = np.full((ROWS, COLS), BG, dtype=np.int16)
        if Z0 <= k <= Z1:
            cx, cy = helix(float(k))
            img[np.hypot(xs - cx, ys - cy) <= TUBE_R] = TUBE
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CT_IMAGE_STORAGE
        sop_uid = generate_uid()
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CT_IMAGE_STORAGE, sop_uid
        ds.PatientID, ds.PatientName = "CMPRSYN", "CMPR^SYNTH"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study_uid, series_uid
        ds.StudyDate, ds.StudyTime = "20260101", "090000"
        ds.StudyDescription, ds.SeriesDescription = "curved mpr check", "helix tube"
        ds.SeriesNumber, ds.InstanceNumber = 1, k + 1
        ds.Modality = "CT"
        ds.FrameOfReferenceUID = for_uid
        ds.ImagePositionPatient = [ORIGIN_XY, ORIGIN_XY, float(k)]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing, ds.SliceThickness = [1.0, 1.0], 1.0
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 1
        ds.RescaleIntercept, ds.RescaleSlope = 0, 1
        ds.WindowCenter, ds.WindowWidth = 200, 1500
        ds.PixelData = img.tobytes()
        ds.save_as(os.path.join(out, f"h_{k + 1:03d}.dcm"), enforce_file_format=True)
    # らせんの解析的な長さ: 速さ = sqrt((R·ω)^2 + 1) (ω = 2π·TURNS/(Z1−Z0) [rad/mm]) を z で積分
    omega = 2 * math.pi * TURNS / (Z1 - Z0)
    length = math.sqrt((R * omega) ** 2 + 1.0) * (Z1 - Z0)
    json.dump({"R": R, "turns": TURNS, "z0": Z0, "z1": Z1, "tubeR": TUBE_R, "bg": BG, "tube": TUBE,
               "originXY": ORIGIN_XY, "dims": [COLS, ROWS, N], "lengthMm": length},
              open(os.path.join(out, "truth.json"), "w"))


if __name__ == "__main__":
    main(sys.argv[1])
