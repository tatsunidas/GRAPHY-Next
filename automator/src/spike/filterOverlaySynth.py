"""フィルタ層の重ね表示スパイク用の合成 CT（filterOverlayCheck.ts から呼ぶ）。

等方 1 mm・1 slice 1 mm の円柱状の明るい円板を 3 つ（半径 2・4・6 mm）。背景 0 HU、円板 +100 HU。
表示窓は 中心 50・幅 400（背景は暗い灰色、円板はそれより明るい灰色で飽和しない）。
引数: 出力先 / 行列の大きさ / StudyInstanceUID（省略で新規）。患者情報は合成の値だけ。
"""
import json
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

out = sys.argv[1]
N = int(sys.argv[2])
study = sys.argv[3] if len(sys.argv) > 3 else generate_uid()
series, forr = generate_uid(), generate_uid()
D = 6
INTERCEPT = -1024
yy, xx = np.meshgrid(np.arange(N), np.arange(N), indexing="ij")
vol = np.full((D, N, N), 1024, dtype=np.uint16)  # 0 HU
centers = {}
if N == 64:
    centers = {2: (32, 12), 4: (32, 32), 6: (32, 54)}  # (行, 列)
for r, (cy, cx) in centers.items():
    disc = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
    vol[:, disc] = 1124  # +100 HU

frames = []
for z in range(D):
    fm = FileMetaDataset()
    sop = generate_uid()
    fm.MediaStorageSOPClassUID = CTImageStorage
    fm.MediaStorageSOPInstanceUID = sop
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    d = Dataset()
    d.file_meta = fm
    d.SOPClassUID = CTImageStorage
    d.SOPInstanceUID = sop
    d.PatientName = "SYNTH^FILTEROVERLAY"
    d.PatientID = "SYNTHFILTEROVERLAY"
    d.PatientBirthDate = "19010203"
    d.PatientSex = "O"
    d.StudyInstanceUID = study
    d.SeriesInstanceUID = series
    d.Modality = "CT"
    d.SeriesNumber = 1 if N == 64 else 2
    d.InstanceNumber = z + 1
    d.SeriesDescription = f"synthetic discs {N}"
    d.FrameOfReferenceUID = forr
    d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ipp = [0.0, 0.0, float(z)]
    d.ImagePositionPatient = ipp
    d.PixelSpacing = [1.0, 1.0]
    d.SliceThickness = 1.0
    d.Rows = N
    d.Columns = N
    d.BitsAllocated = 16
    d.BitsStored = 16
    d.HighBit = 15
    d.SamplesPerPixel = 1
    d.PhotometricInterpretation = "MONOCHROME2"
    d.PixelRepresentation = 0
    d.RescaleSlope = 1
    d.RescaleIntercept = INTERCEPT
    d.WindowCenter = 50
    d.WindowWidth = 400
    d.PixelData = vol[z].tobytes()
    d.StudyDate = "20260101"
    d.save_as(f"{out}/ct_{z:03d}.dcm", enforce_file_format=True)
    frames.append({"sopInstanceUid": sop, "imagePositionPatient": ipp})

print(json.dumps({
    "studyInstanceUid": study, "seriesInstanceUid": series, "rows": N, "columns": N,
    "centers": {str(k): v for k, v in centers.items()}, "frames": frames,
}))
