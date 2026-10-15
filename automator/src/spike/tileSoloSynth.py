"""tileSoloCheck.ts 用の合成データ: 1 患者・1 スタディ・4 シリーズ（CT、各 16 枚、128×128）。

実データが無い環境でも、タイルを 4 枚開く検査を再現できるようにするための補助。画素は検査用の模様で、
臨床データではない。使い方: python3 -I tileSoloSynth.py <出力ディレクトリ>
"""
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
N_SLICES, ROWS, COLS = 16, 128, 128


def pattern(kind: int, z: int) -> np.ndarray:
    yy, xx = np.mgrid[0:ROWS, 0:COLS]
    base = {
        0: xx * 8,                     # 横グラデーション
        1: yy * 8,                     # 縦グラデーション
        2: ((xx // 16 + yy // 16) % 2) * 900,  # 市松
        3: np.hypot(xx - 64, yy - 64) * 12,    # 同心円
    }[kind]
    return (base + z * 40).astype(np.int16)


def main(out: str) -> None:
    os.makedirs(out, exist_ok=True)
    study_uid = generate_uid()
    for s in range(4):
        series_uid = generate_uid()
        for z in range(N_SLICES):
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = CT_IMAGE_STORAGE
            sop_uid = generate_uid()
            meta.MediaStorageSOPInstanceUID = sop_uid
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.ImplementationClassUID = generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.SOPClassUID, ds.SOPInstanceUID = CT_IMAGE_STORAGE, sop_uid
            ds.PatientID, ds.PatientName = "TILESOLO", "TILESOLO^SYNTH"
            ds.StudyInstanceUID, ds.SeriesInstanceUID = study_uid, series_uid
            ds.StudyDate, ds.StudyTime = "20260101", "090000"
            ds.StudyDescription = "tile solo check"
            ds.SeriesDescription = f"synthetic {s + 1}"
            ds.SeriesNumber, ds.InstanceNumber = s + 1, z + 1
            ds.Modality = "CT"
            ds.FrameOfReferenceUID = study_uid
            ds.ImagePositionPatient = [0, 0, z * 3.0]
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
            ds.PixelSpacing, ds.SliceThickness = [1.5, 1.5], 3.0
            ds.Rows, ds.Columns = ROWS, COLS
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated = ds.BitsStored = 16
            ds.HighBit, ds.PixelRepresentation = 15, 1
            ds.RescaleIntercept, ds.RescaleSlope = 0, 1
            ds.WindowCenter, ds.WindowWidth = 500, 1000
            ds.PixelData = pattern(s, z).tobytes()
            ds.save_as(os.path.join(out, f"s{s + 1}_{z + 1:02d}.dcm"), enforce_file_format=True)


if __name__ == "__main__":
    main(sys.argv[1])
