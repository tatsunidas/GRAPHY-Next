"""ROI 特徴量表のスパイク用の合成 CT（roiFeatureCheck.ts から呼ぶ）。

48x48x16・画素 0.7x0.7 mm・スライス 2.0 mm・Rescale -1000。患者情報は合成の値だけ。
SEG はアプリの書き出し API で作るので、ここでは CT だけを書き、SEG に要る幾何を JSON で標準出力へ返す。
"""
import json
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

out = sys.argv[1]
W = H = 48
D = 16
SPACING = [0.7, 0.7]
THICK = 2.0
study, series, forr = (generate_uid() for _ in range(3))
# 実行ごとに画素を変える（同じ画素だと前回の実行のキャッシュが当たり、「新しく計算した」検査にならない）。
rng = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else None)
# 第 3 引数: RescaleIntercept（既定 -1000＝全部負の値。正の値を含めたいときに変える）
INTERCEPT = int(sys.argv[3]) if len(sys.argv) > 3 else -1000
yy, xx = np.meshgrid(np.arange(H) - 24, np.arange(W) - 24, indexing="ij")
vol = (rng.integers(0, 300, (D, H, W)) + np.hypot(xx, yy)[None] * 4).astype(np.uint16)

frames = []
for z in range(D):
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = CTImageStorage
    sop = generate_uid()
    fm.MediaStorageSOPInstanceUID = sop
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    d = Dataset()
    d.file_meta = fm
    d.SOPClassUID = CTImageStorage
    d.SOPInstanceUID = sop
    d.PatientName = "SYNTH^ROIFEAT"
    d.PatientID = "SYNTHROIFEAT"
    d.PatientBirthDate = "19010203"
    d.PatientSex = "O"
    d.StudyInstanceUID = study
    d.SeriesInstanceUID = series
    d.Modality = "CT"
    d.SeriesNumber = 1
    d.InstanceNumber = z + 1
    d.SeriesDescription = "synthetic roi-feature phantom"
    d.FrameOfReferenceUID = forr
    d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ipp = [0.0, 0.0, z * THICK]
    d.ImagePositionPatient = ipp
    d.PixelSpacing = SPACING
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
    d.RescaleIntercept = INTERCEPT
    d.WindowCenter = -800
    d.WindowWidth = 600
    d.PixelData = vol[z].tobytes()
    d.StudyDate = "20260101"
    d.save_as(f"{out}/ct_{z:03d}.dcm", enforce_file_format=True)
    frames.append({"sopInstanceUid": sop, "imagePositionPatient": ipp})

print(json.dumps({
    "studyInstanceUid": study,
    "seriesInstanceUid": series,
    "frameOfReferenceUID": forr,
    "rows": H,
    "columns": W,
    "pixelSpacing": SPACING,
    "sliceThickness": THICK,
    "frames": frames,
}))
