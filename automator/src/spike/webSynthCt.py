"""web モード 4 画面の検査用の合成 CT（webFourViewsCheck.ts から呼ぶ）。

64x64x120・画素 0.8x0.8 mm・スライス 2.5 mm・Rescale -1000。患者情報は合成の値だけ。
画素は seed 固定の疎なノイズ＋球＋Z 方向の傾斜で、MPR の 3 断面すべてに構造が写る。
standalone の取り込みとスタブ DICOMweb の配信に同じファイルを使うので、2 つの経路の表示画素を比べられる。
dicomweb-index.json（属性の DICOM JSON）も同じ場所に書く。標準出力へ study/series の UID を JSON で返す。
"""
import json
import sys

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

out = sys.argv[1]
# 任意: 枚数・患者名・患者 ID・シリーズ説明（マニュアルの画面撮影で複数の検査を作るため。省略時は web 検査と同じ）。
D = int(sys.argv[2]) if len(sys.argv) > 2 else 120
PNAME = sys.argv[3] if len(sys.argv) > 3 else "SYNTH^WEBVIEWS"
PID = sys.argv[4] if len(sys.argv) > 4 else "SYNTHWEBVIEWS"
SDESC = sys.argv[5] if len(sys.argv) > 5 else "synthetic web views phantom"
STDESC = sys.argv[6] if len(sys.argv) > 6 else "synthetic web views"
W = H = 64
SPACING = [0.8, 0.8]
THICK = 2.5
study, series, forr = (generate_uid() for _ in range(3))
rng = np.random.default_rng(20261028)
zz, yy, xx = np.meshgrid(np.arange(D), np.arange(H), np.arange(W), indexing="ij")
sphere = (np.hypot(np.hypot(xx - 32, yy - 32), (zz - D // 2) * THICK / SPACING[0]) < 22) * 600
slope = zz * 4 + xx * 2
vol = (rng.integers(0, 40, (D, H, W)) + sphere + slope).astype(np.uint16)

index = []
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
    d.PatientName = PNAME
    d.PatientID = PID
    d.PatientBirthDate = "19010203"
    d.PatientSex = "O"
    d.StudyInstanceUID = study
    d.SeriesInstanceUID = series
    d.Modality = "CT"
    d.SeriesNumber = 1
    d.InstanceNumber = z + 1
    d.StudyDescription = STDESC
    d.SeriesDescription = SDESC
    d.FrameOfReferenceUID = forr
    d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    d.ImagePositionPatient = [0.0, 0.0, z * THICK]
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
    d.RescaleIntercept = -1000
    d.WindowCenter = -300
    d.WindowWidth = 1200
    d.StudyDate = "20260101"
    # スタブ DICOMweb 用の属性（DICOM JSON）。画素は含めない（QIDO／metadata は画素を返さない）。
    index.append({"file": f"ct_{z:03d}.dcm", "sop": sop, "json": d.to_json_dict()})
    d.PixelData = vol[z].tobytes()
    d.save_as(f"{out}/ct_{z:03d}.dcm", enforce_file_format=True)

with open(f"{out}/dicomweb-index.json", "w") as f:
    json.dump(index, f)

print(json.dumps({"studyInstanceUid": study, "seriesInstanceUid": series, "count": D}))
