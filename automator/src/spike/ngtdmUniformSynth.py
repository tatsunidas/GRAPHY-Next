"""NGTDM の一様 ROI の検査用の合成 CT（ngtdmUniformCheck.ts から呼ぶ）。

24x24x12・画素 1.0x1.0 mm・スライス 2.0 mm・Rescale -1000。患者情報は合成の値だけ。
第 2 引数 uniform なら全画素が同じ値、random なら乱数。ROI の箱の位置と幾何を JSON で標準出力へ返す（SEG はアプリの API で作る）。
"""
import json
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

out = sys.argv[1]
mode = sys.argv[2]
seed = int(sys.argv[3])
W = H = 24
D = 12
THICK = 2.0
box = {"r0": 6, "r1": 18, "c0": 6, "c1": 18, "k0": 2, "k1": 10}
study, series, forr = (generate_uid() for _ in range(3))
rng = np.random.default_rng(seed)
if mode == "uniform":
    vol = np.full((D, H, W), 1100, dtype=np.uint16)
else:
    vol = rng.integers(900, 1300, (D, H, W)).astype(np.uint16)

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
    d.PatientName = f"SYNTH^NGTDM{mode.upper()}"
    d.PatientID = f"SYNTHNGTDM{mode.upper()}"
    d.PatientBirthDate = "19010203"
    d.PatientSex = "O"
    d.StudyInstanceUID = study
    d.SeriesInstanceUID = series
    d.Modality = "CT"
    d.SeriesNumber = 1
    d.InstanceNumber = z + 1
    d.SeriesDescription = f"synthetic ngtdm {mode}"
    d.FrameOfReferenceUID = forr
    d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ipp = [0.0, 0.0, z * THICK]
    d.ImagePositionPatient = ipp
    d.PixelSpacing = [1.0, 1.0]
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
    d.WindowCenter = 100
    d.WindowWidth = 400
    d.PixelData = vol[z].tobytes()
    d.StudyDate = "20260101"
    d.save_as(f"{out}/ct_{z:03d}.dcm", enforce_file_format=True)
    frames.append({"k": z, "sopInstanceUid": sop, "imagePositionPatient": ipp})

print(json.dumps({
    "studyInstanceUid": study,
    "seriesInstanceUid": series,
    "frameOfReferenceUID": forr,
    "rows": H,
    "columns": W,
    "pixelSpacing": [1.0, 1.0],
    "sliceThickness": THICK,
    "iop": [1, 0, 0, 0, 1, 0],
    "frames": frames,
    "box": box,
}))
