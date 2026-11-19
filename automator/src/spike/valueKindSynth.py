"""値の種類（離散の校正値・連続の校正値・任意単位）の検査用の合成シリーズ（valueKindCheck.ts から呼ぶ）。

使い方: python3 -I valueKindSynth.py <出力の親ディレクトリ> <乱数の種>
6 つのシリーズを <親>/<名前>/ に書き、SEG に要る幾何と、ROI の箱を JSON で標準出力へ返す。
  ct_hu      CT・ORIGINAL・RescaleType=HU・整数の Rescale        → 離散
  ct_notype  CT・ORIGINAL・RescaleType なし（実データに多い）      → 離散（CT の画素値は HU）
  ct_derived CT・DERIVED・RescaleType=HU（派生の CT）            → 離散にならない
  mr         MR・ORIGINAL・Rescale なし                          → 任意単位
  adc        MR・DERIVED・RescaleType=mm2/s・傾き 1e-6（ADC 相当） → 連続（ビン幅が要る）
  pet        PT・BQML（体重・投与量あり）                        → SUVbw で連続（ビン幅 0.10）
患者情報は合成の値だけ。値は乱数（実行ごとに変える）。ROI の箱の外は別の値にして、箱の取り違えを検出できるようにする。
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (CTImageStorage, ExplicitVRLittleEndian, MRImageStorage,
                         PositronEmissionTomographyImageStorage, generate_uid)

root = sys.argv[1]
rng = np.random.default_rng(int(sys.argv[2]))
W = H = 24
D = 10
SPACING = [0.7, 0.7]
THICK = 2.0
BOX = {"r0": 6, "r1": 18, "c0": 6, "c1": 18, "z0": 2, "z1": 8}


def series(name, modality, sop_class, stored, slope, intercept, image_type, rescale_type, extra=None):
    out = os.path.join(root, name)
    os.makedirs(out, exist_ok=True)
    study, ser, forr = (generate_uid() for _ in range(3))
    frames = []
    for z in range(D):
        fm = FileMetaDataset()
        fm.MediaStorageSOPClassUID = sop_class
        sop = generate_uid()
        fm.MediaStorageSOPInstanceUID = sop
        fm.TransferSyntaxUID = ExplicitVRLittleEndian
        d = Dataset()
        d.file_meta = fm
        d.SOPClassUID = sop_class
        d.SOPInstanceUID = sop
        d.PatientName = f"SYNTH^{name.upper()}"
        d.PatientID = f"SYNTHVK-{name}"
        d.PatientBirthDate = "19010203"
        d.PatientSex = "M"
        d.StudyInstanceUID = study
        d.SeriesInstanceUID = ser
        d.Modality = modality
        d.SeriesNumber = 1
        d.InstanceNumber = z + 1
        d.SeriesDescription = f"synthetic value-kind {name}"
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
        if image_type:
            d.ImageType = image_type
        if slope is not None:
            d.RescaleSlope = slope
            d.RescaleIntercept = intercept
        if rescale_type:
            d.RescaleType = rescale_type
        d.PixelData = stored[z].astype(np.uint16).tobytes()
        d.StudyDate = "20260101"
        d.StudyTime = "120000"
        d.SeriesDate = "20260101"
        d.SeriesTime = "120000"
        d.AcquisitionDate = "20260101"
        d.AcquisitionTime = "120000"
        if extra:
            extra(d)
        d.save_as(os.path.join(out, f"{name}_{z:03d}.dcm"), enforce_file_format=True)
        frames.append({"sopInstanceUid": sop, "imagePositionPatient": ipp})
    return {"name": name, "dir": out, "studyInstanceUid": study, "seriesInstanceUid": ser, "frameOfReferenceUID": forr,
            "rows": H, "columns": W, "pixelSpacing": SPACING, "sliceThickness": THICK, "frames": frames}


def volume(lo, hi, outside):
    """ROI の箱の中は [lo, hi) の乱数（整数）、箱の外は `outside`（箱の取り違えを検出する）。"""
    v = np.full((D, H, W), outside, dtype=np.int64)
    z0, z1, r0, r1, c0, c1 = BOX["z0"], BOX["z1"], BOX["r0"], BOX["r1"], BOX["c0"], BOX["c1"]
    v[z0:z1, r0:r1, c0:c1] = rng.integers(lo, hi, (z1 - z0, r1 - r0, c1 - c0))
    return v


def pet_header(d):
    d.Units = "BQML"
    d.PatientWeight = "70"
    d.DecayCorrection = "START"
    d.CorrectedImage = ["NORM", "ATTN", "SCAT", "DECY"]
    rad = Dataset()
    rad.RadionuclideTotalDose = "300000000"
    rad.RadionuclideHalfLife = "6586.2"
    rad.RadiopharmaceuticalStartTime = "120000.000000"  # 撮像と同じ時刻（減衰の補正は 0）
    code = Dataset()
    code.CodeValue = "C-111A1"
    code.CodingSchemeDesignator = "SRT"
    code.CodeMeaning = "^18^Fluorine"
    rad.RadionuclideCodeSequence = Sequence([code])
    d.RadiopharmaceuticalInformationSequence = Sequence([rad])


all_series = [
    # CT: 保存値 = HU + 1024（傾き 1・切片 -1024）。箱の中 -300..400 HU
    (series("ct_hu", "CT", CTImageStorage, volume(724, 1424, 0), 1, -1024, ["ORIGINAL", "PRIMARY", "AXIAL"], "HU")),
    (series("ct_notype", "CT", CTImageStorage, volume(724, 1424, 0), 1, -1024, ["ORIGINAL", "PRIMARY", "AXIAL"], None)),
    (series("ct_derived", "CT", CTImageStorage, volume(724, 1424, 0), 1, -1024, ["DERIVED", "SECONDARY", "AXIAL"], "HU")),
    (series("mr", "MR", MRImageStorage, volume(100, 4000, 0), None, None, ["ORIGINAL", "PRIMARY", "M"], None)),
    # ADC 相当: 保存値 500..3000 × 1e-6 = 0.0005..0.003 mm2/s
    (series("adc", "MR", MRImageStorage, volume(500, 3000, 0), 1e-6, 0, ["DERIVED", "SECONDARY", "ADC"], "mm2/s")),
    # PET: 保存値 0..30000 Bq/mL。SUVbw = 値 × 70000 g / 3e8 Bq ≈ 0..7
    (series("pet", "PT", PositronEmissionTomographyImageStorage, volume(1000, 30000, 0), 1, 0, ["ORIGINAL", "PRIMARY"], None, pet_header)),
]
print(json.dumps({"box": BOX, "series": all_series}))
