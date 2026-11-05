#!/usr/bin/env python3
"""合成の DWI ファントム（DICOM）を作る。患者情報を含まない。操作ガイドと実アプリの検査（cdwiPhantomCheck）で使う。

既知の ADC（組織 0.0010・円柱 5 本 0.0008〜0.0030 mm²/s）から S = S0·exp(-b·ADC) で、b ごとに 1 系列（8 スライス）を作る。
b 値は標準の DiffusionBValue (0018,9087)（FD）に入れる。向きは IOP が単位行列・IPP が z 方向に等間隔（LPS）。

使い方:
  python3 make-dwi-phantom.py <出力フォルダ> [--patient-id PH-B400-800] [--b 400,800] [--truth]
出力: <出力フォルダ>/b<b>/z01.dcm …（--truth のとき truth.json も）。
"""
import argparse
import json
import os

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

NX = NY = 96
NZ = 8
PS = 2.5      # mm
ST = 5.0      # mm
S0 = 30000.0
BODY_ADC = 0.0010
DISKS = [  # (中心 x, 中心 y, 半径 px, ADC [mm²/s])
    (30, 32, 7, 0.0008), (66, 32, 7, 0.0012), (48, 48, 7, 0.0016), (30, 66, 7, 0.0020), (66, 66, 7, 0.0030),
]


def phantom():
    yy, xx = np.mgrid[0:NY, 0:NX]
    body = ((xx - 47.5) / 42.0) ** 2 + ((yy - 47.5) / 40.0) ** 2 <= 1.0
    adc = np.where(body, BODY_ADC, 0.0)
    for cx, cy, r, a in DISKS:
        adc = np.where((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r, a, adc)
    return body, adc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--patient-id", default="PH-B400-800")
    ap.add_argument("--b", default="400,800")
    ap.add_argument("--truth", action="store_true")
    a = ap.parse_args()
    bs = [int(x) for x in a.b.split(",")]
    body, adc = phantom()
    study_uid, for_uid = generate_uid(), generate_uid()
    for num, b in enumerate(bs, start=1):
        d = os.path.join(a.out, f"b{b}")
        os.makedirs(d, exist_ok=True)
        series_uid = generate_uid()
        pix = np.rint(np.where(body, S0 * np.exp(-b * adc), 0.0)).astype("<u2")
        for z in range(NZ):
            sop = generate_uid()
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
            meta.MediaStorageSOPInstanceUID = sop
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.ImplementationClassUID = generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.SOPClassUID = meta.MediaStorageSOPClassUID
            ds.SOPInstanceUID = sop
            ds.PatientName = "PHANTOM^BVAL"
            ds.PatientID = a.patient_id
            ds.StudyInstanceUID = study_uid
            ds.StudyDate = "20261105"
            ds.StudyDescription = "Digital DWI phantom b" + "/b".join(str(x) for x in bs)
            ds.SeriesInstanceUID = series_uid
            ds.SeriesNumber = num
            ds.SeriesDescription = f"Phantom DWI b{b}"
            ds.Modality = "MR"
            ds.ImageType = ["ORIGINAL", "PRIMARY", "DIFFUSION", "NONE"]
            ds.FrameOfReferenceUID = for_uid
            ds.InstanceNumber = z + 1
            ds.AcquisitionNumber = 1
            ds.Rows, ds.Columns = NY, NX
            ds.PixelSpacing = [PS, PS]
            ds.SliceThickness = ST
            ds.SpacingBetweenSlices = ST
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
            ds.ImagePositionPatient = [-NX * PS / 2, -NY * PS / 2, z * ST]
            ds.SamplesPerPixel = 1
            ds.PhotometricInterpretation = "MONOCHROME2"
            ds.BitsAllocated = 16
            ds.BitsStored = 16
            ds.HighBit = 15
            ds.PixelRepresentation = 0
            ds.RescaleIntercept = 0
            ds.RescaleSlope = 1
            ds.WindowCenter = S0 / 2
            ds.WindowWidth = S0
            ds.add_new(0x00189087, "FD", float(b))
            ds.PixelData = pix.tobytes()
            ds.save_as(os.path.join(d, f"z{z + 1:02d}.dcm"), enforce_file_format=True)
    if a.truth:
        json.dump({"nx": NX, "ny": NY, "nz": NZ, "S0": S0, "body": body.tolist(), "adc": adc.tolist()}, open(os.path.join(a.out, "truth.json"), "w"))
    print("ok", a.out)


if __name__ == "__main__":
    main()
